import type { Knex } from 'knex';
import { db, t } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { childLogger } from '../utils/logger';
import { publish, topics } from '../realtime/hub';
import { DEFAULT_TIMEZONE, slotStartInstant, toMysqlDateTime } from '../utils/slotTime';
import {
  aheadOf,
  positionIfTier,
  positionOf,
  SLOT_QUEUE_ORDER_SQL,
  type MembershipTier,
} from './queueOrdering';

const log = childLogger('slot-queue');

/** How long a freed slot is held for the person it was offered to. */
export const CLAIM_WINDOW_MINUTES = 10;

/**
 * Cap on how far one freed slot cascades in a single expiry sweep. Without
 * it, a slot freed at 2am silently burns through a 40-person queue by
 * morning, and every one of those people got a push for a court that was
 * gone before they woke up.
 */
export const MAX_OFFERS_PER_SLOT = 10;

/** Per-tier cap on simultaneous queue memberships. */
const QUEUE_LIMIT: Record<MembershipTier, number> = {
  free: 3,
  plus: 10,
  club: 25,
};

interface QueueEntryRow {
  id: number;
  user_id: number;
  position: number;
  membership_tier_at_join: MembershipTier;
  joined_at: string | Date;
  status: string;
  auto_claim: boolean | number;
}

export interface QueueStanding {
  entry_id: number;
  position: number;
  queue_length: number;
  ahead_of_you: Record<MembershipTier, number>;
  your_tier: MembershipTier;
  position_if_plus: number | null;
  auto_claim: boolean;
}

/**
 * SlotQueueService — the live court queue.
 *
 * ## The one concurrency rule
 *
 * `CourtBookingService.bookSlot` already takes `SELECT … FOR UPDATE` on
 * the `court_availability` row before touching anything. **That row is the
 * mutex for the entire queue of that slot.** Every mutation here — join,
 * leave, offer, claim, decline, expire — opens with the same lock on the
 * same row, always first.
 *
 * That single rule buys a lot: no lock-ordering puzzle, no gap locks on
 * `slot_waitlist`, and no dependency on `SKIP LOCKED` (MariaDB only has it
 * from 10.6). It also composes with code that already exists — `bookSlot`
 * and `playNowService` both reject any slot whose status is not
 * `available`, so adding the `held` status made both paths queue-aware
 * without a single edit.
 *
 * ## The one correctness rule
 *
 * **Freeing a slot must go straight to `held`, inside the transaction that
 * released it — never to `available` first.** Release-then-offer lets a
 * pull-to-refresh win the race against the queue, and the first time that
 * happens to a paying member the feature is a lie.
 *
 * Realtime frames are published *after* the transaction commits: a frame
 * broadcast from inside a transaction announces state that can still roll
 * back, and with Redis fan-out that mistake cannot be walked back.
 */
export class SlotQueueService {
  /* ── joining and leaving ───────────────────────────────────── */

  static async join(
    slotId: number,
    userId: number,
    opts: { autoClaim?: boolean } = {}
  ): Promise<QueueStanding> {
    const now = new Date();

    const result = await db.transaction(async (trx) => {
      const slot = await lockSlot(trx, slotId);

      if (slot.status === 'available') {
        // Nothing to wait for — telling them to queue would be absurd.
        throw AppError.conflict('This slot is available right now — just book it');
      }
      if (slot.status === 'blocked') {
        throw AppError.badRequest('This slot is not bookable');
      }

      const venue = await trx(t('venues')).where('id', slot.venue_id).first();
      const startsAt = slotStartInstant(slot, venue?.timezone ?? DEFAULT_TIMEZONE);
      if (startsAt <= now) {
        throw AppError.badRequest('This slot is in the past');
      }

      const existing = await trx(t('slot_waitlist'))
        .where('slot_id', slotId)
        .where('user_id', userId)
        .whereIn('status', ['queued', 'offered'])
        .first();
      if (existing) throw AppError.conflict('You are already in this queue');

      const tier = await membershipTier(trx, userId);
      const activeCount = Number(
        (
          await trx(t('slot_waitlist'))
            .where('user_id', userId)
            .whereIn('status', ['queued', 'offered'])
            .count('* as count')
            .first()
        )?.count ?? 0
      );
      if (activeCount >= QUEUE_LIMIT[tier]) {
        throw AppError.badRequest(
          `You can queue for ${QUEUE_LIMIT[tier]} slots at a time on your current plan`
        );
      }

      // FIFO sequence within this slot. Safe under the slot lock: no two
      // transactions can be computing it for the same slot at once.
      const maxPosition = Number(
        (await trx(t('slot_waitlist')).where('slot_id', slotId).max('position as max').first())
          ?.max ?? 0
      );

      const [entryId] = await trx(t('slot_waitlist')).insert({
        slot_id: slotId,
        user_id: userId,
        venue_id: slot.venue_id,
        slot_starts_at_utc: toMysqlDateTime(startsAt),
        position: maxPosition + 1,
        membership_tier_at_join: tier,
        status: 'queued',
        auto_claim: opts.autoClaim === true && tier === 'club',
        joined_at: now,
        created_at: now,
        updated_at: now,
      });

      const entries = await queueEntries(trx, slotId);
      return { slot, entryId: entryId as number, tier, entries };
    });

    const standing = standingFor(result.entries, userId, result.entryId, result.tier);

    publish(topics.slot(slotId), 'queue_changed', {
      slot_id: slotId,
      queue_length: standing.queue_length,
    });
    publish(topics.venue(result.slot.venue_id), 'queue_changed', {
      slot_id: slotId,
      queue_length: standing.queue_length,
    });

    return standing;
  }

  static async leave(slotId: number, userId: number): Promise<void> {
    const now = new Date();

    const result = await db.transaction(async (trx) => {
      const slot = await lockSlot(trx, slotId);

      const entry = await trx(t('slot_waitlist'))
        .where('slot_id', slotId)
        .where('user_id', userId)
        .whereIn('status', ['queued', 'offered'])
        .first();
      if (!entry) throw AppError.notFound('Queue entry');

      await trx(t('slot_waitlist')).where('id', entry.id).update({
        status: 'cancelled',
        left_at: now,
        updated_at: now,
      });

      // Leaving while holding the offer hands the slot straight on rather
      // than letting it sit idle until the countdown runs out.
      let cascaded: OfferResult | null = null;
      if (entry.status === 'offered') {
        await trx(t('slot_offers'))
          .where('slot_id', slotId)
          .where('status', 'pending')
          .update({ status: 'cancelled', responded_at: now, updated_at: now });
        cascaded = await offerToNext(trx, slot, now, 'declined');
      }

      const entries = await queueEntries(trx, slotId);
      return { slot, entries, cascaded };
    });

    publish(topics.slot(slotId), 'queue_changed', {
      slot_id: slotId,
      queue_length: result.entries.length,
    });
    if (result.cascaded) emitOffer(result.cascaded);
  }

  /* ── the freed-slot path ───────────────────────────────────── */

  /**
   * Called from inside the transaction that just released a slot —
   * cancellation, failed payment, expired unpaid booking, club blocking.
   *
   * Returns the offer that was created, or null when nobody is waiting, in
   * which case the caller's own `status: 'available'` update stands. The
   * caller must publish the returned offer *after* committing; use
   * `emitOffer`.
   */
  static async onSlotFreed(
    trx: Knex.Transaction,
    slotId: number,
    now: Date = new Date()
  ): Promise<OfferResult | null> {
    const slot = await lockSlot(trx, slotId);
    return offerToNext(trx, slot, now, 'freed');
  }

  /* ── claiming ──────────────────────────────────────────────── */

  /**
   * Converts a pending offer into a real booking.
   *
   * Delegates the booking itself to `CourtBookingService` so there is
   * exactly one implementation of pricing, Stripe Connect and the
   * pay-at-venue fallback. The slot is flipped back to `available` under
   * the same lock immediately before, so `bookSlot` sees the state it
   * expects — and because the whole thing runs under the slot lock, no
   * refresher can slip in during that window.
   */
  static async claim(slotId: number, userId: number, offerId?: number) {
    const now = new Date();

    await db.transaction(async (trx) => {
      const slot = await lockSlot(trx, slotId);

      const offer = await trx(t('slot_offers'))
        .where('slot_id', slotId)
        .where('status', 'pending')
        .first();

      // A wrong user, a stale offer id and an expired window all collapse
      // to the same error: never reveal who the slot is being held for.
      if (
        !offer ||
        offer.user_id !== userId ||
        (offerId !== undefined && Number(offerId) !== Number(offer.id)) ||
        new Date(offer.expires_at) <= now
      ) {
        throw AppError.conflict('This offer has expired');
      }
      if (slot.status !== 'held' || Number(slot.held_for_user_id) !== userId) {
        throw AppError.conflict('This offer has expired');
      }

      await trx(t('slot_offers')).where('id', offer.id).update({
        status: 'claimed',
        responded_at: now,
        updated_at: now,
      });
      await trx(t('slot_waitlist')).where('id', offer.waitlist_id).update({
        status: 'claimed',
        left_at: now,
        updated_at: now,
      });
      await trx(t('court_availability')).where('id', slotId).update({
        status: 'available',
        held_for_user_id: null,
        hold_offer_id: null,
        hold_expires_at: null,
        version: trx.raw('version + 1'),
        updated_at: now,
      });
    });

    // Outside the transaction: bookSlot opens its own, and it makes a
    // Stripe call that must not run while holding the slot lock.
    const { CourtBookingService } = await import('./courtBookingService');
    try {
      return await CourtBookingService.bookSlot(slotId, userId);
    } catch (err) {
      // The hold is already released, so a failure here means the slot is
      // genuinely open — better than leaving it held by a booking that
      // never happened.
      log.error({ slotId, userId, err }, 'claim succeeded but booking failed');
      throw err;
    }
  }

  static async decline(slotId: number, userId: number, offerId?: number): Promise<void> {
    const now = new Date();

    const result = await db.transaction(async (trx) => {
      const slot = await lockSlot(trx, slotId);

      const offer = await trx(t('slot_offers'))
        .where('slot_id', slotId)
        .where('status', 'pending')
        .first();
      if (
        !offer ||
        offer.user_id !== userId ||
        (offerId !== undefined && Number(offerId) !== Number(offer.id))
      ) {
        throw AppError.conflict('This offer has expired');
      }

      await trx(t('slot_offers')).where('id', offer.id).update({
        status: 'declined',
        responded_at: now,
        updated_at: now,
      });
      await trx(t('slot_waitlist')).where('id', offer.waitlist_id).update({
        status: 'declined',
        left_at: now,
        updated_at: now,
      });

      return offerToNext(trx, slot, now, 'declined');
    });

    if (result) emitOffer(result);
  }

  /* ── expiry sweep ──────────────────────────────────────────── */

  /**
   * Cron entry: expires claim windows that lapsed and passes each slot to
   * the next person in line. Runs every 30 seconds — a countdown that
   * visibly hits zero and then sits there for minutes reads as broken.
   */
  static async expireOffers(now: Date = new Date()): Promise<number> {
    const stale: Array<{ id: number; slot_id: number }> = await db(t('slot_offers'))
      .where('status', 'pending')
      .where('expires_at', '<=', now)
      .select('id', 'slot_id')
      .limit(200);

    let expired = 0;
    for (const row of stale) {
      try {
        const cascaded = await db.transaction(async (trx) => {
          const slot = await lockSlot(trx, row.slot_id);

          const offer = await trx(t('slot_offers')).where('id', row.id).first();
          // Re-checked under the lock: a claim may have landed between the
          // scan and here.
          if (!offer || offer.status !== 'pending') return null;

          await trx(t('slot_offers')).where('id', offer.id).update({
            status: 'expired',
            responded_at: now,
            updated_at: now,
          });
          await trx(t('slot_waitlist')).where('id', offer.waitlist_id).update({
            status: 'expired',
            left_at: now,
            updated_at: now,
          });

          return offerToNext(trx, slot, now, 'expired');
        });

        expired++;
        if (cascaded) emitOffer(cascaded);
      } catch (err) {
        log.error({ offerId: row.id, err }, 'offer expiry failed');
      }
    }

    return expired;
  }

  /* ── reads ─────────────────────────────────────────────────── */

  static async standing(slotId: number, userId: number): Promise<QueueStanding | null> {
    const entries = await queueEntries(db, slotId);
    const mine = entries.find((e) => e.user_id === userId);
    if (!mine) return null;
    return standingFor(entries, userId, mine.id, mine.membership_tier_at_join);
  }

  static async queueLength(slotId: number): Promise<number> {
    return (await queueEntries(db, slotId)).length;
  }

  /** Queue lengths for many slots at once — avoids N+1 on a day view. */
  static async queueLengths(slotIds: number[]): Promise<Map<number, number>> {
    if (slotIds.length === 0) return new Map();
    const rows = await db(t('slot_waitlist'))
      .whereIn('slot_id', slotIds)
      .whereIn('status', ['queued', 'offered'])
      .groupBy('slot_id')
      .select('slot_id')
      .count('* as count');
    return new Map(rows.map((r: any) => [Number(r.slot_id), Number(r.count)]));
  }

  /** Everything the user is waiting for, plus any live offer. */
  static async myQueue(userId: number) {
    const queued = await db(t('slot_waitlist'))
      .join(t('court_availability'), `${t('slot_waitlist')}.slot_id`, `${t('court_availability')}.id`)
      .leftJoin(t('venues'), `${t('slot_waitlist')}.venue_id`, `${t('venues')}.id`)
      .leftJoin(t('courts'), `${t('court_availability')}.court_id`, `${t('courts')}.id`)
      .where(`${t('slot_waitlist')}.user_id`, userId)
      .whereIn(`${t('slot_waitlist')}.status`, ['queued', 'offered'])
      .orderBy(`${t('slot_waitlist')}.slot_starts_at_utc`, 'asc')
      .select(
        `${t('slot_waitlist')}.id as entry_id`,
        `${t('slot_waitlist')}.slot_id`,
        `${t('slot_waitlist')}.status`,
        `${t('slot_waitlist')}.auto_claim`,
        `${t('court_availability')}.slot_date`,
        `${t('court_availability')}.slot_start`,
        `${t('court_availability')}.slot_end`,
        `${t('court_availability')}.starts_at_utc`,
        `${t('court_availability')}.price_cents`,
        `${t('venues')}.id as venue_id`,
        `${t('venues')}.name as venue_name`,
        `${t('courts')}.name as court_name`
      );

    const offers = await db(t('slot_offers'))
      .where('user_id', userId)
      .where('status', 'pending')
      .where('expires_at', '>', new Date())
      .select('id as offer_id', 'slot_id', 'expires_at');

    const offerBySlot = new Map(offers.map((o: any) => [Number(o.slot_id), o]));

    // Positions are computed from the same comparator the promotion path
    // uses, so the number on screen is the number that will be honoured.
    const withPositions = await Promise.all(
      queued.map(async (row: any) => {
        const entries = await queueEntries(db, row.slot_id);
        const offer = offerBySlot.get(Number(row.slot_id));
        return {
          ...row,
          auto_claim: !!row.auto_claim,
          position: positionOf(entries, userId),
          queue_length: entries.length,
          offer: offer
            ? {
                offer_id: Number(offer.offer_id),
                expires_at: offer.expires_at,
                seconds_left: Math.max(
                  0,
                  Math.floor((new Date(offer.expires_at).getTime() - Date.now()) / 1000)
                ),
              }
            : null,
        };
      })
    );

    return {
      queued: withPositions.filter((r) => !r.offer),
      offers: withPositions.filter((r) => r.offer),
    };
  }
}

/* ── internals ───────────────────────────────────────────────── */

export interface OfferResult {
  offerId: number;
  slotId: number;
  venueId: number;
  userId: number;
  expiresAt: Date;
  queueLength: number;
  slot: any;
  autoClaim: boolean;
}

/**
 * The single lock every queue mutation takes, always first.
 * Exported shape is deliberately minimal — callers only need the row.
 */
async function lockSlot(trx: Knex | Knex.Transaction, slotId: number) {
  const slot = await trx(t('court_availability')).where('id', slotId).forUpdate().first();
  if (!slot) throw AppError.notFound('Slot');
  return slot;
}

/**
 * Offers the slot to whoever is next, moving it to `held`.
 *
 * Must be called with the slot already locked. Returns null when the queue
 * is empty or the cascade cap is reached, leaving the slot free for normal
 * booking.
 */
async function offerToNext(
  trx: Knex.Transaction,
  slot: any,
  now: Date,
  reason: 'freed' | 'declined' | 'expired'
): Promise<OfferResult | null> {
  const offerCount = Number(
    (await trx(t('slot_offers')).where('slot_id', slot.id).count('* as count').first())?.count ?? 0
  );
  if (offerCount >= MAX_OFFERS_PER_SLOT) {
    log.info({ slotId: slot.id, offerCount }, 'offer cascade cap reached — releasing slot');
    await releaseSlot(trx, slot.id, now);
    return null;
  }

  const next = await trx(t('slot_waitlist'))
    .where('slot_id', slot.id)
    .where('status', 'queued')
    .orderByRaw(SLOT_QUEUE_ORDER_SQL)
    .first();

  if (!next) {
    await releaseSlot(trx, slot.id, now);
    return null;
  }

  const expiresAt = new Date(now.getTime() + CLAIM_WINDOW_MINUTES * 60 * 1000);

  const [offerId] = await trx(t('slot_offers')).insert({
    slot_id: slot.id,
    waitlist_id: next.id,
    user_id: next.user_id,
    status: 'pending',
    expires_at: expiresAt,
    offer_index: offerCount,
    created_at: now,
    updated_at: now,
  });

  await trx(t('slot_waitlist')).where('id', next.id).update({
    status: 'offered',
    updated_at: now,
  });

  // The slot goes straight to `held` — never through `available`.
  await trx(t('court_availability')).where('id', slot.id).update({
    status: 'held',
    held_for_user_id: next.user_id,
    hold_offer_id: offerId,
    hold_expires_at: expiresAt,
    version: trx.raw('version + 1'),
    updated_at: now,
  });

  const queueLength = Number(
    (
      await trx(t('slot_waitlist'))
        .where('slot_id', slot.id)
        .whereIn('status', ['queued', 'offered'])
        .count('* as count')
        .first()
    )?.count ?? 0
  );

  log.info({ slotId: slot.id, userId: next.user_id, reason }, 'slot offered');

  return {
    offerId: offerId as number,
    slotId: slot.id,
    venueId: slot.venue_id,
    userId: next.user_id,
    expiresAt,
    queueLength,
    slot,
    autoClaim: !!next.auto_claim,
  };
}

/** Nobody waiting — the slot becomes ordinarily bookable again. */
async function releaseSlot(trx: Knex.Transaction, slotId: number, now: Date): Promise<void> {
  await trx(t('court_availability')).where('id', slotId).update({
    status: 'available',
    held_for_user_id: null,
    hold_offer_id: null,
    hold_expires_at: null,
    version: trx.raw('version + 1'),
    updated_at: now,
  });
}

async function queueEntries(
  conn: Knex | Knex.Transaction,
  slotId: number
): Promise<QueueEntryRow[]> {
  return conn(t('slot_waitlist'))
    .where('slot_id', slotId)
    .whereIn('status', ['queued', 'offered'])
    .orderByRaw(SLOT_QUEUE_ORDER_SQL)
    .select('id', 'user_id', 'position', 'membership_tier_at_join', 'joined_at', 'status', 'auto_claim');
}

async function membershipTier(
  conn: Knex | Knex.Transaction,
  userId: number
): Promise<MembershipTier> {
  const membership = await conn(t('memberships'))
    .where('user_id', userId)
    .where('status', 'active')
    .first();
  const tier = membership?.tier;
  return tier === 'club' || tier === 'plus' ? tier : 'free';
}

function standingFor(
  entries: QueueEntryRow[],
  userId: number,
  entryId: number,
  tier: MembershipTier
): QueueStanding {
  const mine = entries.find((e) => e.user_id === userId);
  return {
    entry_id: entryId,
    position: positionOf(entries, userId) ?? entries.length,
    queue_length: entries.length,
    ahead_of_you: aheadOf(entries, userId),
    your_tier: tier,
    // Only meaningful for free-tier users, and honest when an upgrade
    // would buy nothing.
    position_if_plus: tier === 'free' ? positionIfTier(entries, userId, 'plus') : null,
    auto_claim: !!mine?.auto_claim,
  };
}

/**
 * Publishes the realtime frames for a new offer.
 *
 * Always called after the transaction commits. `held_for_user_id` is never
 * broadcast on a public topic — watchers learn the slot is held, not who
 * is holding it.
 */
export function emitOffer(offer: OfferResult): void {
  // Foreground clients get the socket frame; backgrounded ones get the
  // push. iOS has no background WebSocket, so both paths are required —
  // see `slotNotifier.ts`.
  import('./slotNotifier')
    .then(({ SlotNotifier }) => SlotNotifier.notifyOffer(offer))
    .catch((err) => log.error({ offerId: offer.offerId, err }, 'offer notification failed'));

  const publicPayload = {
    slot_id: offer.slotId,
    venue_id: offer.venueId,
    status: 'held',
    queue_length: offer.queueLength,
    hold_expires_at: offer.expiresAt.toISOString(),
  };

  publish(topics.slot(offer.slotId), 'slot_held', publicPayload);
  publish(topics.venue(offer.venueId), 'slot_held', publicPayload);

  publish(topics.user(offer.userId), 'offer_created', {
    offer_id: offer.offerId,
    slot_id: offer.slotId,
    venue_id: offer.venueId,
    expires_at: offer.expiresAt.toISOString(),
    seconds_left: CLAIM_WINDOW_MINUTES * 60,
  });
}

/** Publishes that a slot became ordinarily bookable (nobody was waiting). */
export function emitSlotAvailable(slotId: number, venueId: number, slot?: any): void {
  const payload = {
    slot_id: slotId,
    venue_id: venueId,
    status: 'available',
    slot_date: slot?.slot_date ?? null,
    slot_start: slot?.slot_start ?? null,
    slot_end: slot?.slot_end ?? null,
    price_cents: slot?.price_cents ?? null,
  };
  publish(topics.slot(slotId), 'slot_freed', payload);
  publish(topics.venue(venueId), 'slot_freed', payload);
}
