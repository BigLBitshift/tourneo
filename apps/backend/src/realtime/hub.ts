import type { Server as HttpServer } from 'http';
import jwt from 'jsonwebtoken';
import { WebSocketServer, WebSocket } from 'ws';
import { env } from '../config/environment';
import { redis } from '../config/redis';
import { childLogger } from '../utils/logger';
import type { AuthTokenPayload } from '../types';

const log = childLogger('realtime');

/**
 * Topic-based realtime hub.
 *
 * Generalises the original bracket-only socket into named topics so court
 * availability, queue positions and claim offers can share one connection
 * per client. Three screens each opening their own socket would mean three
 * TCP connections and three reconnect storms after every deploy.
 *
 * Protocol (JSON over `wss://…/ws?token=<access_jwt>`):
 *
 *   client → { type: 'subscribe',   topics: ['venue:12'], since?: 41221 }
 *   client → { type: 'unsubscribe', topics: ['venue:12'] }
 *   client → { type: 'auth',        token: '<new access jwt>' }
 *   client → { type: 'ping' }
 *
 *   server → { type: 'subscribed',  topics: [...], seq: 41240 }
 *   server → { type: 'resync',      topics: [...], reason: 'gap' }
 *   server → { type: 'event',       topic, seq, ts, event, payload }
 *   server → { type: 'pong', ts }
 *   server → { type: 'error', code, topic? }
 *
 * Payloads deliberately carry only what a client can already see through
 * REST. The socket is an optimisation; the REST endpoint stays the source
 * of truth, which is what makes the `resync` fallback safe.
 *
 * Money-adjacent mutations (claiming a slot) never travel over the socket
 * — they need idempotency, rate limiting and the normal error handler.
 */

export type Topic = string;

interface Frame {
  type: 'event';
  topic: Topic;
  seq: number;
  ts: string;
  event: string;
  payload: unknown;
  /** Set on republished frames so the originating instance ignores them. */
  origin?: string;
}

interface Client {
  socket: WebSocket;
  userId: number | null;
  topics: Set<Topic>;
  isAlive: boolean;
  /** Sliding-window counter for the per-socket frame rate limit. */
  frameWindowStart: number;
  frameCount: number;
}

const MAX_TOPICS_PER_SOCKET = 40;
const MAX_FRAMES_PER_SECOND = 20;
const MAX_SOCKETS_PER_USER = 5;
const MAX_FRAME_BYTES = 64 * 1024;
const HEARTBEAT_MS = 30_000;
const RING_BUFFER_SIZE = 200;
const RING_BUFFER_MS = 5 * 60 * 1000;
const REDIS_CHANNEL = 'tourneo:rt';

/** A per-process identity so Redis fan-out does not echo back to us. */
const INSTANCE_ID = `${process.pid}-${Math.floor(process.uptime() * 1000)}-${Date.now().toString(36)}`;

const clients = new Set<Client>();
const subscribers = new Map<Topic, Set<Client>>();
const localSeq = new Map<Topic, number>();
const ringBuffers = new Map<Topic, Frame[]>();

let wss: WebSocketServer | null = null;
let heartbeat: NodeJS.Timeout | null = null;
let redisSubscriber: ReturnType<typeof redisDuplicate> = null;

function redisDuplicate() {
  if (!redis) return null;
  try {
    return redis.duplicate();
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'redis duplicate failed — staying in-process');
    return null;
  }
}

export function initHub(server: HttpServer): void {
  if (wss) return;
  wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_FRAME_BYTES });

  wss.on('connection', (socket, request) => {
    // RN's WebSocket cannot reliably set headers on iOS, so the token
    // travels as a query param. It is short-lived, this module never logs
    // the request URL, and `utils/logger` redacts `token` fields — so a
    // stray object log cannot leak it either.
    const userId = verifyTokenFromUrl(request.url);

    if (userId !== null && countSocketsForUser(userId) >= MAX_SOCKETS_PER_USER) {
      socket.close(1013, 'too many connections');
      return;
    }

    const client: Client = {
      socket,
      userId,
      topics: new Set(),
      isAlive: true,
      frameWindowStart: Date.now(),
      frameCount: 0,
    };
    clients.add(client);

    socket.on('message', (raw) => handleMessage(client, raw));
    socket.on('pong', () => {
      client.isAlive = true;
    });
    socket.on('close', () => removeClient(client));
    socket.on('error', (err) => {
      log.warn({ err: err.message }, 'socket error');
      removeClient(client);
    });
  });

  heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.isAlive) {
        client.socket.terminate();
        removeClient(client);
        continue;
      }
      client.isAlive = false;
      try {
        client.socket.ping();
      } catch {
        removeClient(client);
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  startRedisFanout();

  log.info({ instance: INSTANCE_ID, redis: !!redisSubscriber }, 'realtime hub listening on /ws');
}

export async function closeHub(): Promise<void> {
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
  if (redisSubscriber) {
    try {
      redisSubscriber.disconnect();
    } catch {
      /* already gone */
    }
    redisSubscriber = null;
  }
  for (const client of [...clients]) {
    try {
      client.socket.close(1001, 'server shutting down');
    } catch {
      /* already closed */
    }
    removeClient(client);
  }
  await new Promise<void>((resolve) => {
    if (!wss) return resolve();
    wss.close(() => resolve());
  });
  wss = null;
  subscribers.clear();
  ringBuffers.clear();
  localSeq.clear();
}

/**
 * Publishes an event to everyone watching `topic`.
 *
 * Fire-and-forget: realtime delivery must never fail the business
 * operation that triggered it. Callers publish *after* their transaction
 * commits — broadcasting from inside one announces state that can still
 * roll back, and with Redis fan-out that mistake is unrecoverable.
 */
export function publish(topic: Topic, event: string, payload: unknown): void {
  const seq = nextSeq(topic);
  const frame: Frame = {
    type: 'event',
    topic,
    seq,
    ts: new Date().toISOString(),
    event,
    payload,
  };

  buffer(frame);
  deliverLocal(frame);

  if (redis) {
    redis
      .publish(REDIS_CHANNEL, JSON.stringify({ ...frame, origin: INSTANCE_ID }))
      .catch((err) => log.warn({ topic, err: err.message }, 'redis publish failed'));
  }
}

/* ── topics ──────────────────────────────────────────────────── */

export const topics = {
  venue: (venueId: number): Topic => `venue:${venueId}`,
  slot: (slotId: number): Topic => `slot:${slotId}`,
  city: (city: string): Topic => `city:${city.trim().toLowerCase().replace(/\s+/g, '-')}`,
  user: (userId: number): Topic => `user:${userId}`,
  event: (eventId: number): Topic => `event:${eventId}`,
};

// Canonical form only — no leading zeros, no uppercase. Subscribing to a
// non-canonical spelling of a real topic would silently receive nothing,
// which is a much harder bug to notice than a rejected subscription.
const PUBLIC_TOPIC = /^(venue|slot|event):[1-9]\d*$|^city:[a-z0-9äöüß-]+$/;
const USER_TOPIC = /^user:([1-9]\d*)$/;

/**
 * Public topics carry only state that is already readable over REST, so
 * anonymous sockets may subscribe. `user:<id>` carries offers and queue
 * positions and is restricted to that user's own authenticated socket.
 */
function maySubscribe(client: Client, topic: Topic): boolean {
  const userMatch = USER_TOPIC.exec(topic);
  if (userMatch) return client.userId !== null && Number(userMatch[1]) === client.userId;
  return PUBLIC_TOPIC.test(topic);
}

/* ── message handling ────────────────────────────────────────── */

function handleMessage(client: Client, raw: unknown): void {
  if (!withinRateLimit(client)) return;

  let msg: any;
  try {
    msg = JSON.parse(String(raw));
  } catch {
    return; // ignore malformed frames rather than closing — a hostile
    // client would simply reconnect, and a buggy one deserves to recover
  }

  switch (msg?.type) {
    case 'subscribe':
      return handleSubscribe(client, msg);
    case 'unsubscribe':
      return handleUnsubscribe(client, msg);
    case 'auth':
      return handleAuth(client, msg);
    case 'ping':
      return send(client, { type: 'pong', ts: new Date().toISOString() });
    default:
      return;
  }
}

function handleSubscribe(client: Client, msg: any): void {
  const requested = normaliseTopics(msg?.topics);
  if (requested.length === 0) return;

  const accepted: Topic[] = [];
  for (const topic of requested) {
    if (!maySubscribe(client, topic)) {
      send(client, { type: 'error', code: 'TOPIC_FORBIDDEN', topic });
      continue;
    }
    if (client.topics.size >= MAX_TOPICS_PER_SOCKET) {
      send(client, { type: 'error', code: 'TOPIC_LIMIT_REACHED', topic });
      break;
    }
    client.topics.add(topic);
    if (!subscribers.has(topic)) subscribers.set(topic, new Set());
    subscribers.get(topic)!.add(client);
    accepted.push(topic);
  }

  if (accepted.length === 0) return;

  // Backfill: a client returning from the background replays what it
  // missed, or is told to refetch when the gap is wider than the buffer.
  const since = Number(msg?.since);
  if (Number.isInteger(since) && since > 0) {
    const gaps: Topic[] = [];
    for (const topic of accepted) {
      const missed = (ringBuffers.get(topic) ?? []).filter((f) => f.seq > since);
      const oldest = ringBuffers.get(topic)?.[0]?.seq ?? Infinity;
      if (oldest > since + 1 && missed.length > 0) {
        gaps.push(topic);
      } else {
        for (const frame of missed) send(client, frame);
      }
    }
    if (gaps.length > 0) send(client, { type: 'resync', topics: gaps, reason: 'gap' });
  }

  send(client, {
    type: 'subscribed',
    topics: accepted,
    seq: Math.max(0, ...accepted.map((topic) => localSeq.get(topic) ?? 0)),
  });
}

function handleUnsubscribe(client: Client, msg: any): void {
  for (const topic of normaliseTopics(msg?.topics)) {
    client.topics.delete(topic);
    const set = subscribers.get(topic);
    set?.delete(client);
    if (set && set.size === 0) subscribers.delete(topic);
  }
}

/**
 * Token rotation without a reconnect. A socket that loses its identity
 * (expired token, sign-out) drops its private topics but keeps the
 * connection and its public subscriptions.
 */
function handleAuth(client: Client, msg: any): void {
  const userId = verifyToken(String(msg?.token ?? ''));
  if (userId === null) {
    send(client, { type: 'error', code: 'INVALID_TOKEN' });
  }
  if (userId !== client.userId) {
    for (const topic of [...client.topics]) {
      if (USER_TOPIC.test(topic)) {
        client.topics.delete(topic);
        subscribers.get(topic)?.delete(client);
      }
    }
  }
  client.userId = userId;
}

function normaliseTopics(value: unknown): Topic[] {
  const list = Array.isArray(value) ? value : [value];
  return [
    ...new Set(
      list
        .filter((v): v is string => typeof v === 'string')
        .map((v) => v.trim())
        .filter((v) => v.length > 0 && v.length <= 96)
    ),
  ].slice(0, MAX_TOPICS_PER_SOCKET);
}

function withinRateLimit(client: Client): boolean {
  const now = Date.now();
  if (now - client.frameWindowStart >= 1000) {
    client.frameWindowStart = now;
    client.frameCount = 0;
  }
  client.frameCount += 1;
  if (client.frameCount > MAX_FRAMES_PER_SECOND) {
    if (client.frameCount === MAX_FRAMES_PER_SECOND + 1) {
      log.warn({ userId: client.userId }, 'socket frame rate limit exceeded — dropping frames');
    }
    return false;
  }
  return true;
}

/* ── delivery ────────────────────────────────────────────────── */

function deliverLocal(frame: Frame): void {
  const targets = subscribers.get(frame.topic);
  if (!targets || targets.size === 0) return;

  const encoded = JSON.stringify({
    type: frame.type,
    topic: frame.topic,
    seq: frame.seq,
    ts: frame.ts,
    event: frame.event,
    payload: frame.payload,
  });

  for (const client of targets) {
    if (client.socket.readyState !== WebSocket.OPEN) continue;
    client.socket.send(encoded, (err) => {
      if (err) log.warn({ topic: frame.topic, err: err.message }, 'send failed');
    });
  }
}

function send(client: Client, message: unknown): void {
  if (client.socket.readyState !== WebSocket.OPEN) return;
  try {
    client.socket.send(JSON.stringify(message));
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'send failed');
  }
}

function removeClient(client: Client): void {
  for (const topic of client.topics) {
    const set = subscribers.get(topic);
    set?.delete(client);
    if (set && set.size === 0) subscribers.delete(topic);
  }
  client.topics.clear();
  clients.delete(client);
}

function countSocketsForUser(userId: number): number {
  let count = 0;
  for (const client of clients) if (client.userId === userId) count++;
  return count;
}

/* ── sequencing and buffering ────────────────────────────────── */

/**
 * Sequence numbers are per-topic and monotonic. With Redis they would
 * ideally come from INCR so they stay globally ordered; publish() is
 * synchronous by design (callers must not have to await delivery), so the
 * local counter is authoritative and the buffer's gap detection makes a
 * cross-instance skew self-correcting via `resync`.
 */
function nextSeq(topic: Topic): number {
  const next = (localSeq.get(topic) ?? 0) + 1;
  localSeq.set(topic, next);
  return next;
}

function buffer(frame: Frame): void {
  const existing = ringBuffers.get(frame.topic) ?? [];
  existing.push(frame);

  const cutoff = Date.now() - RING_BUFFER_MS;
  const trimmed = existing
    .filter((f) => new Date(f.ts).getTime() >= cutoff)
    .slice(-RING_BUFFER_SIZE);

  if (trimmed.length === 0) ringBuffers.delete(frame.topic);
  else ringBuffers.set(frame.topic, trimmed);
}

/* ── multi-instance fan-out ──────────────────────────────────── */

function startRedisFanout(): void {
  redisSubscriber = redisDuplicate();
  if (!redisSubscriber) return;

  redisSubscriber.subscribe(REDIS_CHANNEL, (err) => {
    if (err) {
      log.warn({ err: err.message }, 'redis subscribe failed — hub stays in-process');
      redisSubscriber = null;
    }
  });

  redisSubscriber.on('message', (_channel, message) => {
    try {
      const frame: Frame = JSON.parse(message);
      // Our own publish already delivered locally.
      if (frame.origin === INSTANCE_ID) return;
      const seen = localSeq.get(frame.topic) ?? 0;
      if (frame.seq > seen) localSeq.set(frame.topic, frame.seq);
      buffer(frame);
      deliverLocal(frame);
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'malformed frame on redis channel');
    }
  });
}

/* ── auth helpers ────────────────────────────────────────────── */

function verifyTokenFromUrl(url: string | undefined): number | null {
  if (!url) return null;
  const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
  const token = new URLSearchParams(query).get('token');
  return token ? verifyToken(token) : null;
}

function verifyToken(token: string): number | null {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, env.jwt.accessSecret) as AuthTokenPayload;
    const userId = Number(payload?.userId);
    return Number.isInteger(userId) && userId > 0 ? userId : null;
  } catch {
    return null;
  }
}

/* ── test seam ───────────────────────────────────────────────── */

/** Exposed for tests only — never call from application code. */
export const __testing = {
  maySubscribe,
  normaliseTopics,
  nextSeq,
  buffer,
  ringBuffers,
  localSeq,
  reset(): void {
    subscribers.clear();
    ringBuffers.clear();
    localSeq.clear();
    clients.clear();
  },
};
