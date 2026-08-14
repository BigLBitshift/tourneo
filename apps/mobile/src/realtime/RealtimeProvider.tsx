/**
 * RealtimeProvider — one app-wide WebSocket, shared by every live screen.
 *
 * Three screens each opening their own socket would mean three TCP
 * connections and three reconnect storms after every deploy, so topics are
 * multiplexed over a single connection here and consumed with `useTopic`.
 *
 * iOS constraint, stated plainly: there is no background WebSocket. The
 * socket dies within about 30 seconds of suspension and cannot be revived
 * from the background. So the contract is **foreground = socket,
 * background = push**, and the socket is only ever an optimisation — every
 * screen keeps its REST fetch as the source of truth. That is what makes
 * the server's `resync` frame safe to act on.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { API_BASE_URL } from '../api/client';

const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 1_000;
/** Grace period before a backgrounded app gives up its socket. */
const BACKGROUND_GRACE_MS = 20_000;
/** How long to wait for a pong before declaring a half-open socket dead. */
const PONG_TIMEOUT_MS = 3_000;

export type RealtimeEvent = {
  topic: string;
  event: string;
  payload: any;
  seq: number;
  ts: string;
};

type Handler = (event: RealtimeEvent) => void;

interface RealtimeContextValue {
  connected: boolean;
  subscribe: (topic: string, handler: Handler) => () => void;
  /** Latest resync signal, so screens can force a REST refetch. */
  resyncAt: string | null;
}

const RealtimeContext = createContext<RealtimeContextValue>({
  connected: false,
  subscribe: () => () => undefined,
  resyncAt: null,
});

function wsUrl(token: string | null): string {
  // https://api.tourneo.de/api/v1 → wss://api.tourneo.de/ws
  const origin = API_BASE_URL.replace(/\/api\/v\d+\/?$/, '');
  const base = origin.replace(/^http/, 'ws') + '/ws';
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [resyncAt, setResyncAt] = useState<string | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef(new Map<string, Set<Handler>>());
  /** Highest seq seen per topic, so a reconnect can ask for the gap. */
  const lastSeqRef = useRef(new Map<string, number>());
  const backoffRef = useRef(BASE_BACKOFF_MS);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backgroundTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pongTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backgroundedAtRef = useRef<number | null>(null);
  const unmountedRef = useRef(false);

  const send = useCallback((message: unknown) => {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }, []);

  const subscribeOnSocket = useCallback(
    (topics: string[]) => {
      if (topics.length === 0) return;
      // `since` lets the server replay what we missed, or tell us to
      // refetch when the gap is wider than its buffer.
      const since = Math.min(...topics.map((topic) => lastSeqRef.current.get(topic) ?? 0));
      send({ type: 'subscribe', topics, ...(since > 0 ? { since } : {}) });
    },
    [send]
  );

  const connect = useCallback(async () => {
    if (unmountedRef.current) return;
    if (socketRef.current) return;

    let token: string | null = null;
    try {
      token = await SecureStore.getItemAsync('access_token');
    } catch {
      // anonymous socket — public topics still work
    }

    let socket: WebSocket;
    try {
      socket = new WebSocket(wsUrl(token));
    } catch {
      scheduleRetry();
      return;
    }
    socketRef.current = socket;

    socket.onopen = () => {
      backoffRef.current = BASE_BACKOFF_MS;
      setConnected(true);
      subscribeOnSocket([...handlersRef.current.keys()]);
    };

    socket.onmessage = (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(String(raw.data));
      } catch {
        return;
      }

      if (msg?.type === 'pong') {
        if (pongTimerRef.current) clearTimeout(pongTimerRef.current);
        pongTimerRef.current = null;
        return;
      }

      if (msg?.type === 'resync') {
        // The gap was wider than the server's buffer — screens must
        // refetch over REST rather than trust an incomplete stream.
        setResyncAt(new Date().toISOString());
        return;
      }

      if (msg?.type !== 'event' || typeof msg.topic !== 'string') return;

      const seq = Number(msg.seq);
      if (Number.isInteger(seq)) {
        const seen = lastSeqRef.current.get(msg.topic) ?? 0;
        if (seq <= seen) return; // duplicate from a backfill replay
        lastSeqRef.current.set(msg.topic, seq);
      }

      const handlers = handlersRef.current.get(msg.topic);
      if (!handlers) return;
      const event: RealtimeEvent = {
        topic: msg.topic,
        event: String(msg.event),
        payload: msg.payload,
        seq,
        ts: String(msg.ts ?? new Date().toISOString()),
      };
      // Copy first: a handler may unsubscribe itself while we iterate.
      for (const handler of [...handlers]) {
        try {
          handler(event);
        } catch {
          // a broken screen must not take down the socket
        }
      }
    };

    socket.onclose = () => {
      setConnected(false);
      socketRef.current = null;
      scheduleRetry();
    };

    socket.onerror = () => {
      // onclose fires afterwards and owns the retry
      try {
        socket.close();
      } catch {
        // already closing
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribeOnSocket]);

  const closeSocket = useCallback(() => {
    const socket = socketRef.current;
    socketRef.current = null;
    setConnected(false);
    if (!socket) return;
    try {
      socket.close();
    } catch {
      // already closed
    }
  }, []);

  const scheduleRetry = useCallback(() => {
    if (unmountedRef.current) return;
    if (retryRef.current) clearTimeout(retryRef.current);
    // Jitter matters: without it every client in the country reconnects
    // on the same tick after a deploy and stampedes the server.
    const jittered = backoffRef.current * (0.5 + Math.random() * 0.5);
    retryRef.current = setTimeout(() => {
      retryRef.current = null;
      connect();
    }, jittered);
    backoffRef.current = Math.min(backoffRef.current * 2, MAX_BACKOFF_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connect]);

  /**
   * The number-one React Native WebSocket defect: after returning from the
   * background, `readyState` frequently still reports OPEN while the
   * underlying TCP connection is dead. Never trust it across a background
   * transition — ping, and treat silence as death.
   */
  const verifyAlive = useCallback(() => {
    if (!send({ type: 'ping' })) {
      closeSocket();
      connect();
      return;
    }
    if (pongTimerRef.current) clearTimeout(pongTimerRef.current);
    pongTimerRef.current = setTimeout(() => {
      pongTimerRef.current = null;
      closeSocket();
      connect();
    }, PONG_TIMEOUT_MS);
  }, [send, closeSocket, connect]);

  useEffect(() => {
    unmountedRef.current = false;
    connect();

    const onAppStateChange = (state: AppStateStatus) => {
      if (state === 'active') {
        if (backgroundTimerRef.current) {
          clearTimeout(backgroundTimerRef.current);
          backgroundTimerRef.current = null;
        }
        const away = backgroundedAtRef.current ? Date.now() - backgroundedAtRef.current : 0;
        backgroundedAtRef.current = null;

        if (!socketRef.current) {
          backoffRef.current = BASE_BACKOFF_MS;
          connect();
        } else if (away > BACKGROUND_GRACE_MS / 2) {
          verifyAlive();
        }
        return;
      }

      // Backgrounded: hold the socket briefly — a quick app switch should
      // not cost a reconnect — then let it go rather than have iOS kill it
      // mid-frame.
      backgroundedAtRef.current = Date.now();
      if (backgroundTimerRef.current) clearTimeout(backgroundTimerRef.current);
      backgroundTimerRef.current = setTimeout(() => {
        backgroundTimerRef.current = null;
        closeSocket();
      }, BACKGROUND_GRACE_MS);
    };

    const subscription = AppState.addEventListener('change', onAppStateChange);

    return () => {
      unmountedRef.current = true;
      subscription.remove();
      if (retryRef.current) clearTimeout(retryRef.current);
      if (backgroundTimerRef.current) clearTimeout(backgroundTimerRef.current);
      if (pongTimerRef.current) clearTimeout(pongTimerRef.current);
      closeSocket();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const subscribe = useCallback(
    (topic: string, handler: Handler) => {
      let handlers = handlersRef.current.get(topic);
      const isNewTopic = !handlers;
      if (!handlers) {
        handlers = new Set();
        handlersRef.current.set(topic, handlers);
      }
      handlers.add(handler);
      if (isNewTopic) subscribeOnSocket([topic]);

      return () => {
        const current = handlersRef.current.get(topic);
        if (!current) return;
        current.delete(handler);
        if (current.size === 0) {
          handlersRef.current.delete(topic);
          send({ type: 'unsubscribe', topics: [topic] });
        }
      };
    },
    [subscribeOnSocket, send]
  );

  const value = useMemo(
    () => ({ connected, subscribe, resyncAt }),
    [connected, subscribe, resyncAt]
  );

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(): RealtimeContextValue {
  return useContext(RealtimeContext);
}

/**
 * Subscribes to one topic for the lifetime of the component.
 *
 * The handler is kept in a ref so a screen can pass an inline arrow
 * without re-subscribing on every render.
 */
export function useTopic(
  topic: string | null | undefined,
  handler: Handler
): { connected: boolean; resyncAt: string | null } {
  const { subscribe, connected, resyncAt } = useRealtime();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!topic) return;
    return subscribe(topic, (event) => handlerRef.current(event));
  }, [topic, subscribe]);

  return { connected, resyncAt };
}
