/**
 * useLiveBracket — subscribes to the backend's live-bracket WebSocket
 * hub and reports when the bracket of an event changed, so the screen
 * can refetch via its existing REST call.
 *
 *   const { lastUpdate, connected } = useLiveBracket(eventId);
 *   useEffect(() => { if (lastUpdate) refetchBracket(); }, [lastUpdate]);
 *
 * Behaviour:
 *   - Auto-reconnect with capped exponential backoff (1s → 30s).
 *   - Cleans up socket + timers on unmount / eventId change.
 *   - Degrades silently when the server has no WS endpoint (older
 *     backend) — screens keep working with pull-to-refresh.
 */
import { useEffect, useRef, useState } from 'react';
import { API_BASE_URL } from '../api/client';

const MAX_BACKOFF_MS = 30_000;

function wsUrl(): string {
  // https://api.tourneo.de/api/v1 → wss://api.tourneo.de/ws
  const origin = API_BASE_URL.replace(/\/api\/v\d+\/?$/, '');
  return origin.replace(/^http/, 'ws') + '/ws';
}

export function useLiveBracket(eventId: number | null | undefined) {
  const [lastUpdate, setLastUpdate] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backoffRef = useRef(1000);
  const closedByUs = useRef(false);

  useEffect(() => {
    if (!eventId) return;
    closedByUs.current = false;

    const connect = () => {
      if (closedByUs.current) return;
      let socket: WebSocket;
      try {
        socket = new WebSocket(wsUrl());
      } catch {
        scheduleRetry();
        return;
      }
      socketRef.current = socket;

      socket.onopen = () => {
        backoffRef.current = 1000;
        setConnected(true);
        socket.send(JSON.stringify({ type: 'subscribe', event_id: eventId }));
      };

      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data));
          if (msg?.type === 'bracket_update' && Number(msg.event_id) === eventId) {
            setLastUpdate(msg.ts || new Date().toISOString());
          }
        } catch {
          // ignore malformed frames
        }
      };

      socket.onclose = () => {
        setConnected(false);
        socketRef.current = null;
        scheduleRetry();
      };

      socket.onerror = () => {
        // onclose fires afterwards and handles the retry
        socket.close();
      };
    };

    const scheduleRetry = () => {
      if (closedByUs.current) return;
      if (retryRef.current) clearTimeout(retryRef.current);
      retryRef.current = setTimeout(connect, backoffRef.current);
      backoffRef.current = Math.min(backoffRef.current * 2, MAX_BACKOFF_MS);
    };

    connect();

    return () => {
      closedByUs.current = true;
      if (retryRef.current) clearTimeout(retryRef.current);
      const socket = socketRef.current;
      if (socket) {
        try {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'unsubscribe', event_id: eventId }));
          }
          socket.close();
        } catch {
          // already closed
        }
      }
      socketRef.current = null;
      setConnected(false);
    };
  }, [eventId]);

  return { lastUpdate, connected };
}
