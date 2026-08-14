/**
 * Live-bracket compatibility shim.
 *
 * The bracket socket was the first realtime feature and owned the whole
 * `/ws` endpoint. `hub.ts` generalises it into named topics so court
 * availability, queue positions and claim offers share one connection per
 * client. Brackets keep their original public API — `bracketService.ts`
 * and `index.ts` call these two functions and need no changes.
 *
 * Wire-compatible with the old client: a bracket subscriber now sends
 * `{ type: 'subscribe', topics: ['event:123'] }` instead of
 * `{ type: 'subscribe', event_id: 123 }`, and receives the update inside
 * an `event` envelope. The mobile hook is updated alongside; the payload
 * still carries `event_id` so a client that only reads the payload keeps
 * working.
 */
import { initHub, publish, topics } from './hub';

export { initHub as initLiveBracket };

/**
 * Notifies everyone watching an event that its bracket changed.
 * Fire-and-forget — never throws into the caller's flow.
 */
export function broadcastBracketUpdate(eventId: number): void {
  publish(topics.event(eventId), 'bracket_update', { event_id: eventId });
}
