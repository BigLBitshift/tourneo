import { db, t } from '../config/database';
import { childLogger } from '../utils/logger';
import { NotificationService } from './notificationService';
import { DEFAULT_TIMEZONE } from '../utils/slotTime';
import type { OfferResult } from './slotQueueService';

const log = childLogger('slot-notifier');

export interface NotificationPrefs {
  timezone: string;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  slot_alerts_enabled: boolean;
  pause_offers_during_quiet_hours: boolean;
  max_slot_alerts_per_day: number;
}

const DEFAULT_PREFS: NotificationPrefs = {
  timezone: DEFAULT_TIMEZONE,
  quiet_hours_start: '22:00:00',
  quiet_hours_end: '08:00:00',
  slot_alerts_enabled: true,
  pause_offers_during_quiet_hours: false,
  max_slot_alerts_per_day: 5,
};

/**
 * Push delivery for the live court queue.
 *
 * On iOS there is no background WebSocket — sockets die within about 30
 * seconds of suspension and cannot be revived. So the architecture is
 * exactly: **foreground = WebSocket, background = push.** Everything here
 * exists because of that sentence.
 *
 * An offer is time-critical and expires on its own, so quiet hours mute
 * the *push* rather than withholding the offer — silently costing someone
 * a court because it was 22:30 would be worse than a late buzz. Users who
 * disagree can set `pause_offers_during_quiet_hours`.
 */
export class SlotNotifier {
  static async prefsFor(userId: number): Promise<NotificationPrefs> {
    const row = await db(t('notification_prefs')).where('user_id', userId).first();
    if (!row) return DEFAULT_PREFS;
    return {
      timezone: row.timezone || DEFAULT_TIMEZONE,
      quiet_hours_start: row.quiet_hours_start,
      quiet_hours_end: row.quiet_hours_end,
      slot_alerts_enabled: !!row.slot_alerts_enabled,
      pause_offers_during_quiet_hours: !!row.pause_offers_during_quiet_hours,
      max_slot_alerts_per_day: Number(row.max_slot_alerts_per_day ?? 5),
    };
  }

  static async updatePrefs(
    userId: number,
    patch: Partial<NotificationPrefs>
  ): Promise<NotificationPrefs> {
    const now = new Date();
    const existing = await db(t('notification_prefs')).where('user_id', userId).first();

    if (existing) {
      await db(t('notification_prefs'))
        .where('user_id', userId)
        .update({ ...patch, updated_at: now });
    } else {
      await db(t('notification_prefs')).insert({
        user_id: userId,
        ...DEFAULT_PREFS,
        ...patch,
        created_at: now,
        updated_at: now,
      });
    }
    return this.prefsFor(userId);
  }

  /**
   * "Ein Platz ist frei geworden" — the push that makes the whole feature
   * worth building. Fire-and-forget: a failed push must never roll back a
   * successful offer.
   */
  static async notifyOffer(offer: OfferResult, now: Date = new Date()): Promise<void> {
    try {
      const prefs = await this.prefsFor(offer.userId);
      if (!prefs.slot_alerts_enabled) return;

      const venue = await db(t('venues')).where('id', offer.venueId).select('name').first();
      const minutes = Math.max(
        1,
        Math.round((offer.expiresAt.getTime() - now.getTime()) / 60_000)
      );
      const when = formatSlotWhen(offer.slot);
      const where = venue?.name ?? 'deinem Club';

      // Stable across retries of the same offer, so a job that runs twice
      // cannot double-send. The unique index on notifications.dedupe_key
      // enforces it at the storage layer.
      const dedupeKey = `slot_offer:${offer.offerId}`;

      const quiet = isQuietHour(now, prefs);
      const inserted = await this.insertOnce({
        userId: offer.userId,
        type: 'slot_offer',
        title: 'Platz frei! 🎾',
        body: `${where}${when ? `, ${when}` : ''} — für dich reserviert. Du hast ${minutes} Min.`,
        data: {
          slot_id: offer.slotId,
          offer_id: offer.offerId,
          venue_id: offer.venueId,
          expires_at: offer.expiresAt.toISOString(),
          // The client routes straight to the claim screen; the offer push
          // is specifically the one that arrives while the app is dead.
          deeplink: `tourneo://slot/${offer.slotId}/claim`,
        },
        dedupeKey,
        now,
      });

      if (!inserted) return; // already delivered

      if (quiet && prefs.pause_offers_during_quiet_hours) {
        log.info({ userId: offer.userId, offerId: offer.offerId }, 'quiet hours — push muted');
        return;
      }

      await NotificationService.send(
        offer.userId,
        'general',
        'Platz frei! 🎾',
        `${where}${when ? `, ${when}` : ''} — für dich reserviert. Du hast ${minutes} Min.`,
        {
          slot_id: offer.slotId,
          offer_id: offer.offerId,
          deeplink: `tourneo://slot/${offer.slotId}/claim`,
        },
        { skipDbInsert: true }
      );
    } catch (err) {
      log.error({ offerId: offer.offerId, err }, 'offer push failed');
    }
  }

  /**
   * Inserts the inbox row, returning false when the dedupe key already
   * exists. Relies on the unique index rather than a read-then-write, so
   * two concurrent workers cannot both decide they are first.
   */
  private static async insertOnce(params: {
    userId: number;
    type: string;
    title: string;
    body: string;
    data: Record<string, unknown>;
    dedupeKey: string;
    now: Date;
  }): Promise<boolean> {
    try {
      await db(t('notifications')).insert({
        user_id: params.userId,
        type: params.type,
        title: params.title,
        body: params.body,
        data: JSON.stringify(params.data),
        dedupe_key: params.dedupeKey,
        created_at: params.now,
      });
      return true;
    } catch (err: any) {
      if (err?.code === 'ER_DUP_ENTRY' || err?.errno === 1062) return false;
      throw err;
    }
  }
}

/**
 * Is `instant` inside the user's local quiet hours?
 * Handles windows that wrap past midnight (22:00 → 08:00 is the default).
 */
export function isQuietHour(instant: Date, prefs: NotificationPrefs): boolean {
  if (!prefs.quiet_hours_start || !prefs.quiet_hours_end) return false;

  const local = new Intl.DateTimeFormat('en-GB', {
    timeZone: prefs.timezone || DEFAULT_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(instant);

  const nowMinutes = toMinutes(local);
  const start = toMinutes(String(prefs.quiet_hours_start));
  const end = toMinutes(String(prefs.quiet_hours_end));

  if (start === end) return false;
  return start < end
    ? nowMinutes >= start && nowMinutes < end
    : nowMinutes >= start || nowMinutes < end; // wraps midnight
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** "Sa, 14. Aug, 19:00" from the slot's own calendar fields. */
function formatSlotWhen(slot: { slot_date?: string | Date; slot_start?: string } | undefined): string {
  if (!slot?.slot_date || !slot?.slot_start) return '';
  const raw = slot.slot_date instanceof Date
    ? slot.slot_date.toISOString().slice(0, 10)
    : String(slot.slot_date).slice(0, 10);
  const [y, m, d] = raw.split('-').map(Number);
  if (!y || !m || !d) return '';

  const date = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('de-DE', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
  return `${date}, ${String(slot.slot_start).slice(0, 5)} Uhr`;
}
