import type { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { childLogger } from '../utils/logger';

const log = childLogger('live-bracket');

/**
 * Live-bracket WebSocket hub.
 *
 * Protocol (JSON over ws at path /ws):
 *   client → { "type": "subscribe",   "event_id": 123 }
 *   client → { "type": "unsubscribe", "event_id": 123 }
 *   server → { "type": "bracket_update", "event_id": 123, "ts": "…" }
 *
 * The server intentionally sends only a lightweight "something changed"
 * signal — clients refetch the bracket via the REST endpoint they
 * already use. This avoids duplicating the bracket serialisation logic
 * and keeps the socket payload tiny.
 *
 * Multi-instance note: broadcasts are in-process. When the API scales
 * past one instance, add a Redis pub/sub fan-out here (subscribe on
 * boot, publish in broadcastBracketUpdate) — the public API of this
 * module stays identical.
 */

const subscriptions = new Map<number, Set<WebSocket>>();
let wss: WebSocketServer | null = null;

export function initLiveBracket(server: HttpServer): void {
  if (wss) return;
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (socket) => {
    const mySubscriptions = new Set<number>();

    socket.on('message', (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return; // ignore malformed frames
      }
      const eventId = Number(msg?.event_id);
      if (!Number.isInteger(eventId) || eventId <= 0) return;

      if (msg.type === 'subscribe') {
        if (mySubscriptions.size >= 20) return; // abuse guard
        if (!subscriptions.has(eventId)) subscriptions.set(eventId, new Set());
        subscriptions.get(eventId)!.add(socket);
        mySubscriptions.add(eventId);
      } else if (msg.type === 'unsubscribe') {
        subscriptions.get(eventId)?.delete(socket);
        mySubscriptions.delete(eventId);
      }
    });

    socket.on('close', () => {
      for (const eventId of mySubscriptions) {
        const set = subscriptions.get(eventId);
        set?.delete(socket);
        if (set && set.size === 0) subscriptions.delete(eventId);
      }
    });

    socket.on('error', (err) => {
      log.warn({ err: err.message }, 'socket error');
    });
  });

  log.info('live-bracket WebSocket hub listening on /ws');
}

/**
 * Notifies all sockets watching an event that its bracket changed.
 * Fire-and-forget — never throws into the caller's flow.
 */
export function broadcastBracketUpdate(eventId: number): void {
  const sockets = subscriptions.get(eventId);
  if (!sockets || sockets.size === 0) return;

  const frame = JSON.stringify({
    type: 'bracket_update',
    event_id: eventId,
    ts: new Date().toISOString(),
  });

  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(frame, (err) => {
        if (err) log.warn({ eventId, err: err.message }, 'broadcast send failed');
      });
    }
  }
}
