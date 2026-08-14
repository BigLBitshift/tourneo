import { v4 as uuidv4 } from 'uuid';
import type { Knex } from 'knex';
import { db, t } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { StripeConnectService } from './stripeConnectService';
import { DEFAULT_TIMEZONE, slotStartInstant, toDateString } from '../utils/slotTime';
import {
  emitOffer,
  emitSlotAvailable,
  SlotQueueService,
  type OfferResult,
} from './slotQueueService';

const CANCELLATION_CUTOFF_HOURS = 2;
const UNPAID_BOOKING_TTL_MINUTES = 15;

/**
 * CourtBookingService — in-app booking of court_availability slots.
 *
 * Concurrency: the slot row is locked (SELECT … FOR UPDATE) for the whole
 * check-and-book transaction, so two users tapping the same slot at the
 * same moment serialize — the second one gets a clean "already booked"
 * error instead of a double booking.
 *
 * Payment: when the venue is Stripe-Connect-enabled and the slot carries
 * a price, the booking starts as `pending_payment` and a destination-
 * charge PaymentIntent is returned (club gets the money, Tourneo keeps
 * platform_fee_percent). Unpaid bookings expire after 15 minutes and the
 * slot is released. Venues without Stripe fall back to pay-at-venue with
 * an immediately confirmed booking — booking always works, payment
 * capability only upgrades the flow.
 */
export class CourtBookingService {
  static async bookSlot(slotId: number, userId: number, notes?: string) {
    const now = new Date();
    const uuid = uuidv4();

    const result = await db.transaction(async (trx) => {
      const slot = await trx(t('court_availability'))
        .where('id', slotId)
        .forUpdate()
        .first();

      if (!slot) throw AppError.notFound('Slot');
      if (slot.status !== 'available') {
        throw AppError.conflict('This slot is no longer available');
      }

      const venue = await trx(t('venues')).where('id', slot.venue_id).first();

      const slotStart = slotStartInstant(slot, venue?.timezone ?? DEFAULT_TIMEZONE);
      if (slotStart <= now) {
        throw AppError.badRequest('This slot is in the past');
      }

      const canPayInApp =
        StripeConnectService.isConfigured() &&
        !!venue?.stripe_account_id &&
        (slot.price_cents ?? 0) > 0;

      const [id] = await trx(t('court_bookings')).insert({
        uuid,
        slot_id: slot.id,
        venue_id: slot.venue_id,
        court_id: slot.court_id ?? null,
        user_id: userId,
        status: canPayInApp ? 'pending_payment' : 'confirmed',
        price_cents: slot.price_cents ?? null,
        currency: 'EUR',
        payment_method: canPayInApp ? 'card' : 'pay_at_venue',
        notes: notes?.slice(0, 500) ?? null,
        booked_at: now,
        created_at: now,
        updated_at: now,
      });

      await trx(t('court_availability')).where('id', slot.id).update({
        status: 'booked',
        updated_at: now,
      });

      if (!canPayInApp) {
        await trx(t('notifications')).insert({
          user_id: userId,
          type: 'general',
          title: 'Platz gebucht',
          body: `Deine Buchung am ${formatDate(slot.slot_date)} um ${formatTime(slot.slot_start)} ist bestätigt.`,
          data: JSON.stringify({ booking_id: id, venue_id: slot.venue_id }),
          created_at: now,
        });
      }

      return {
        bookingId: id as number,
        canPayInApp,
        amountCents: slot.price_cents as number | null,
        venueStripeAccountId: (venue?.stripe_account_id as string | null) ?? null,
        platformFeePercent: Number(venue?.platform_fee_percent ?? 10),
      };
    });

    // Stripe call happens OUTSIDE the transaction — network calls inside
    // a DB transaction would hold the slot lock for the whole roundtrip.
    let checkoutUrl: string | null = null;
    if (result.canPayInApp && result.amountCents) {
      try {
        const intent = await StripeConnectService.createBookingPaymentIntent({
          bookingId: result.bookingId,
          bookingUuid: uuid,
          amountCents: result.amountCents,
          venueStripeAccountId: result.venueStripeAccountId,
          platformFeePercent: result.platformFeePercent,
          userId,
        });
        if (intent) {
          checkoutUrl = intent.checkout_url;
          await db(t('court_bookings')).where('id', result.bookingId).update({
            stripe_payment_intent_id: intent.payment_intent_id,
            updated_at: new Date(),
          });
        }
      } catch (err) {
        // Payment setup failed — degrade gracefully to pay-at-venue so the
        // user keeps their slot instead of losing it to a Stripe hiccup.
        console.error('[bookings] PaymentIntent creation failed, falling back:', err);
        await db(t('court_bookings')).where('id', result.bookingId).update({
          status: 'confirmed',
          payment_method: 'pay_at_venue',
          updated_at: new Date(),
        });
      }
    }

    const booking = await this.getBookingById(result.bookingId, userId);
    return { ...booking, checkout_url: checkoutUrl };
  }

  /**
   * Webhook entry: marks a pending booking paid when its PaymentIntent
   * succeeds. Idempotent — repeated webhooks are no-ops.
   */
  static async confirmPaidBooking(paymentIntentId: string): Promise<void> {
    const now = new Date();
    await db.transaction(async (trx) => {
      const booking = await trx(t('court_bookings'))
        .where('stripe_payment_intent_id', paymentIntentId)
        .forUpdate()
        .first();
      if (!booking || booking.status !== 'pending_payment') return;

      await trx(t('court_bookings')).where('id', booking.id).update({
        status: 'confirmed',
        updated_at: now,
      });
      await trx(t('notifications')).insert({
        user_id: booking.user_id,
        type: 'general',
        title: 'Platz gebucht & bezahlt ✅',
        body: 'Deine Platzbuchung ist bestätigt. Viel Spaß beim Spielen!',
        data: JSON.stringify({ booking_id: booking.id, venue_id: booking.venue_id }),
        created_at: now,
      });
    });
  }

  /**
   * Webhook entry: failed payment cancels the pending booking and frees
   * the slot for others.
   */
  static async failPaidBooking(paymentIntentId: string): Promise<void> {
    const now = new Date();
    const released = await db.transaction(async (trx) => {
      const booking = await trx(t('court_bookings'))
        .where('stripe_payment_intent_id', paymentIntentId)
        .forUpdate()
        .first();
      if (!booking || booking.status !== 'pending_payment') return null;

      await trx(t('court_bookings')).where('id', booking.id).update({
        status: 'cancelled',
        cancelled_at: now,
        updated_at: now,
      });
      return releaseSlotToQueue(trx, booking.slot_id, now);
    });

    announceRelease(released);
  }

  /**
   * Cron-friendly: cancels pending_payment bookings older than 15 min
   * and releases their slots. Safe to call from any scheduler.
   */
  static async expireUnpaidBookings(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - UNPAID_BOOKING_TTL_MINUTES * 60 * 1000);
    const stale = await db(t('court_bookings'))
      .where('status', 'pending_payment')
      .where('booked_at', '<', cutoff)
      .select('id', 'slot_id');

    let expired = 0;
    for (const row of stale) {
      const released = await db.transaction(async (trx) => {
        const booking = await trx(t('court_bookings'))
          .where('id', row.id)
          .forUpdate()
          .first();
        if (!booking || booking.status !== 'pending_payment') return null;
        await trx(t('court_bookings')).where('id', row.id).update({
          status: 'cancelled',
          cancelled_at: now,
          updated_at: now,
        });
        expired++;
        return releaseSlotToQueue(trx, row.slot_id, now);
      });

      announceRelease(released);
    }
    return expired;
  }

  static async cancelBooking(bookingId: number, userId: number, isAdmin = false) {
    const now = new Date();

    const released = await db.transaction(async (trx) => {
      const booking = await trx(t('court_bookings'))
        .where('id', bookingId)
        .forUpdate()
        .first();

      if (!booking) throw AppError.notFound('Booking');
      if (!isAdmin && booking.user_id !== userId) {
        // 404, not 403 — don't leak other users' bookings.
        throw AppError.notFound('Booking');
      }
      if (booking.status === 'cancelled') {
        throw AppError.badRequest('Booking is already cancelled');
      }

      const slot = await trx(t('court_availability'))
        .where('id', booking.slot_id)
        .forUpdate()
        .first();

      if (slot && !isAdmin) {
        // Membership perk: Plus/Club members can cancel until 30 minutes
        // before start; free tier keeps the 2-hour cutoff.
        const membership = await trx(t('memberships'))
          .where('user_id', booking.user_id)
          .where('status', 'active')
          .first();
        const isPaidTier = membership?.tier === 'plus' || membership?.tier === 'club';
        const cutoffMs = isPaidTier
          ? 30 * 60 * 1000
          : CANCELLATION_CUTOFF_HOURS * 60 * 60 * 1000;

        const venue = await trx(t('venues')).where('id', slot.venue_id).first();
        const slotStart = slotStartInstant(slot, venue?.timezone ?? DEFAULT_TIMEZONE);
        const cutoff = new Date(slotStart.getTime() - cutoffMs);
        if (now > cutoff) {
          throw AppError.badRequest(
            isPaidTier
              ? 'Bookings can only be cancelled up to 30 minutes before the start time'
              : `Bookings can only be cancelled up to ${CANCELLATION_CUTOFF_HOURS} hours before the start time. Plus/Club members can cancel until 30 minutes before.`
          );
        }
      }

      await trx(t('court_bookings')).where('id', bookingId).update({
        status: 'cancelled',
        cancelled_at: now,
        updated_at: now,
      });

      // Free the slot again — straight to the queue if anyone is waiting.
      if (slot && slot.status === 'booked') {
        return releaseSlotToQueue(trx, slot.id, now);
      }
      return null;
    });

    announceRelease(released);

    return { id: bookingId, status: 'cancelled' as const };
  }

  static async getBookingById(bookingId: number, userId: number) {
    const booking = await this.bookingQuery()
      .where(`${t('court_bookings')}.id`, bookingId)
      .where(`${t('court_bookings')}.user_id`, userId)
      .first();
    if (!booking) throw AppError.notFound('Booking');
    return booking;
  }

  static async listUserBookings(userId: number, opts: { upcomingOnly?: boolean } = {}) {
    let query = this.bookingQuery()
      .where(`${t('court_bookings')}.user_id`, userId)
      .orderBy(`${t('court_availability')}.slot_date`, 'desc')
      .orderBy(`${t('court_availability')}.slot_start`, 'desc')
      .limit(100);

    if (opts.upcomingOnly) {
      query = query
        .where(`${t('court_bookings')}.status`, 'confirmed')
        .where(`${t('court_availability')}.slot_date`, '>=', new Date().toISOString().slice(0, 10));
    }

    return query;
  }

  private static bookingQuery() {
    return db(t('court_bookings'))
      .leftJoin(t('court_availability'), `${t('court_bookings')}.slot_id`, `${t('court_availability')}.id`)
      .leftJoin(t('venues'), `${t('court_bookings')}.venue_id`, `${t('venues')}.id`)
      .leftJoin(t('courts'), `${t('court_bookings')}.court_id`, `${t('courts')}.id`)
      .select(
        `${t('court_bookings')}.*`,
        `${t('court_availability')}.slot_date`,
        `${t('court_availability')}.slot_start`,
        `${t('court_availability')}.slot_end`,
        `${t('venues')}.name as venue_name`,
        `${t('venues')}.address_street as venue_street`,
        `${t('venues')}.address_city as venue_city`,
        `${t('courts')}.name as court_name`
      );
  }
}

/**
 * Result of freeing a slot: either it went to the next person in the
 * queue, or nobody was waiting and it is ordinarily bookable again.
 *
 * The distinction matters because the realtime frame differs, and because
 * both must be published only after the caller's transaction commits.
 */
type SlotRelease =
  | { kind: 'offered'; offer: OfferResult }
  | { kind: 'available'; slotId: number; venueId: number; slot: any };

/**
 * Hands a freed slot to the queue, inside the caller's transaction.
 *
 * Critically this never passes through `available`: `onSlotFreed` moves
 * the row straight from `booked` to `held` under the slot lock. Releasing
 * first and offering afterwards would let a pull-to-refresh beat the
 * queue, which makes the queue a lie the first time it happens.
 */
async function releaseSlotToQueue(
  trx: Knex.Transaction,
  slotId: number,
  now: Date
): Promise<SlotRelease | null> {
  const offer = await SlotQueueService.onSlotFreed(trx, slotId, now);
  if (offer) return { kind: 'offered', offer };

  const slot = await trx(t('court_availability')).where('id', slotId).first();
  if (!slot) return null;
  return { kind: 'available', slotId, venueId: slot.venue_id, slot };
}

/** Publishes the realtime frame for a release. Never throws into the caller. */
function announceRelease(released: SlotRelease | null): void {
  if (!released) return;
  try {
    if (released.kind === 'offered') emitOffer(released.offer);
    else emitSlotAvailable(released.slotId, released.venueId, released.slot);
  } catch (err) {
    console.error('[bookings] realtime publish failed:', err);
  }
}

function formatDate(slotDate: string | Date): string {
  // Formatted from the calendar day itself, not from an instant — the
  // club's Saturday must not become Friday for a reader east of UTC.
  const [y, m, d] = toDateString(slotDate).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('de-DE', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

function formatTime(slotTime: string): string {
  return String(slotTime).slice(0, 5);
}
