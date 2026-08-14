/**
 * useLiveBracket — reports when an event's bracket changed, so the screen
 * can refetch via its existing REST call.
 *
 *   const { lastUpdate, connected } = useLiveBracket(eventId);
 *   useEffect(() => { if (lastUpdate) refetchBracket(); }, [lastUpdate]);
 *
 * Now a thin wrapper over the app-wide `RealtimeProvider` socket rather
 * than a connection of its own: brackets, court availability and claim
 * offers all multiplex over one connection, so opening a bracket while
 * queued for a court no longer costs a second socket and a second
 * reconnect loop.
 *
 * Degrades silently when the socket is unavailable — screens keep working
 * with pull-to-refresh, and `resyncAt` forces a refetch when the socket
 * reconnects after a gap too wide to replay.
 */
import { useState } from 'react';
import { useTopic } from '../realtime/RealtimeProvider';

export function useLiveBracket(eventId: number | null | undefined) {
  const [lastUpdate, setLastUpdate] = useState<string | null>(null);

  const { connected, resyncAt } = useTopic(
    eventId ? `event:${eventId}` : null,
    (event) => {
      if (event.event === 'bracket_update') {
        setLastUpdate(event.ts || new Date().toISOString());
      }
    }
  );

  // A resync means we may have missed a bracket update entirely; treat it
  // as an update so the screen refetches.
  return { lastUpdate: resyncAt && resyncAt > (lastUpdate ?? '') ? resyncAt : lastUpdate, connected };
}
