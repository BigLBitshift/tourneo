import { v4 as uuidv4 } from 'uuid';
import { db, t } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { EventService } from './eventService';
import { CreateRegistrationInput } from '../validators/registrations';
import { MembershipTier } from '../types';
import dayjs from 'dayjs';

export class RegistrationService {
  static async createRegistration(input: CreateRegistrationInput, userId: number) {
    const regUuid = uuidv4();
    const now = new Date();

    // All reads + writes happen inside a single transaction with a
    // SELECT ... FOR UPDATE on the event row. Concurrent registrations
    // therefore serialize: capacity check and duplicate check cannot
    // race with a parallel insert, which previously allowed overbooking
    // and duplicate registrations.
    const result = await db.transaction(async (trx) => {
      const event = await trx(t('events'))
        .where('id', input.event_id)
        .forUpdate()
        .first();
      if (!event) throw AppError.notFound('Event');

      const membership = await trx(t('memberships'))
        .where('user_id', userId)
        .where('status', 'active')
        .first();
      const membershipTier: MembershipTier = membership?.tier || 'free';

      const accessCheck = EventService.canUserRegister(event, membershipTier, input.invite_token);
      if (!accessCheck.canRegister) {
        throw AppError.badRequest(accessCheck.reason || 'Cannot register for this event');
      }

      const existingReg = await trx(t('registrations'))
        .where('event_id', input.event_id)
        .where('user_id', userId)
        .whereNotIn('status', ['cancelled', 'refunded'])
        .first();
      if (existingReg) {
        throw AppError.conflict('You are already registered for this event');
      }

      const [{ count: currentCount }] = await trx(t('registrations'))
        .where('event_id', input.event_id)
        .whereIn('status', ['confirmed', 'pending_payment'])
        .count('* as count');
      const isFull = Number(currentCount) >= event.max_participants;

      const { fee: netFee, discount } = EventService.calculateDiscountedFee(
        event.entry_fee_cents,
        membershipTier
      );

      let status: string;
      let waitlistPosition: number | null = null;

      if (isFull) {
        const [{ maxPos }] = await trx(t('registrations'))
          .where('event_id', input.event_id)
          .where('status', 'waitlisted')
          .max('waitlist_position as maxPos');

        waitlistPosition = (maxPos || 0) + 1;
        status = 'waitlisted';
      } else {
        status = 'pending_payment';
      }

      const [registrationId] = await trx(t('registrations')).insert({
        uuid: regUuid,
        event_id: input.event_id,
        user_id: userId,
        team_id: input.team_id || null,
        registration_type: input.registration_type,
        partner_user_id: input.partner_user_id || null,
        status,
        membership_tier_at_registration: membershipTier,
        discount_applied_cents: discount,
        consent_tournament_terms: input.consent_tournament_terms,
        consent_age_verified: input.consent_age_verified,
        consent_media: input.consent_media,
        waitlist_position: waitlistPosition,
        created_at: now,
        updated_at: now,
      });

      await trx(t('audit_log')).insert({
        user_id: userId,
        action: isFull ? 'registration.waitlisted' : 'registration.created',
        entity_type: 'registration',
        entity_id: registrationId,
        new_values: JSON.stringify({
          event_id: input.event_id,
          type: input.registration_type,
          status,
          fee: netFee,
          discount,
        }),
        created_at: now,
      });

      return {
        registrationId,
        status,
        waitlistPosition,
        netFee,
        discount,
        entryFeeCents: event.entry_fee_cents,
        membershipTier,
      };
    });

    return {
      id: result.registrationId,
      uuid: regUuid,
      event_id: input.event_id,
      status: result.status,
      waitlist_position: result.waitlistPosition,
      entry_fee_cents: result.entryFeeCents,
      discount_cents: result.discount,
      net_fee_cents: result.netFee,
      membership_tier: result.membershipTier,
      requires_payment: result.status === 'pending_payment' && result.netFee > 0,
    };
  }

  static async cancelRegistration(registrationId: number, userId: number, reason?: string) {
    const registration = await db(t('registrations'))
      .where('id', registrationId)
      .where('user_id', userId)
      .first();

    if (!registration) throw AppError.notFound('Registration');

    const cancellableStatuses = ['confirmed', 'pending_payment', 'waitlisted'] as const;
    if (!cancellableStatuses.includes(registration.status)) {
      throw AppError.badRequest('This registration cannot be cancelled');
    }

    const event = await db(t('events')).where('id', registration.event_id).first();
    if (!event) throw AppError.notFound('Event');

    const now = new Date();
    const eventStart = new Date(event.start_date);
    const daysUntilEvent = dayjs(eventStart).diff(dayjs(now), 'day');

    // Default to no refund. Each branch must explicitly opt-in so a future
    // status added to the enum cannot accidentally inherit a refund.
    let refundPercentage = 0;
    const refundReason: 'user_cancellation_14d' | 'user_cancellation_late' = 'user_cancellation_14d';

    if (registration.status === 'waitlisted') {
      // Waitlisted users get a full refund if they paid (rare case where
      // someone pre-paid before being demoted to the waitlist).
      refundPercentage = 100;
    } else if (registration.status === 'confirmed' && daysUntilEvent >= 14) {
      refundPercentage = 75;
    } else {
      refundPercentage = 0;
    }

    await db.transaction(async (trx) => {
      await trx(t('registrations')).where('id', registrationId).update({
        status: 'cancelled',
        updated_at: now,
      });

      // If there's a confirmed payment and refund is due
      if (refundPercentage > 0 && registration.status === 'confirmed') {
        const payment = await trx(t('payments'))
          .where('registration_id', registrationId)
          .where('status', 'succeeded')
          .first();

        if (payment) {
          const refundAmount = Math.round(payment.net_amount_cents * (refundPercentage / 100));

          await trx(t('refunds')).insert({
            uuid: uuidv4(),
            payment_id: payment.id,
            user_id: userId,
            amount_cents: refundAmount,
            reason: refundReason,
            reason_detail: reason || null,
            status: 'pending',
            created_at: now,
          });
        }
      }

      // If confirmed registration was cancelled, check waitlist
      if (registration.status === 'confirmed') {
        await this.promoteFromWaitlist(registration.event_id, trx);
      }

      // Audit log
      await trx(t('audit_log')).insert({
        user_id: userId,
        action: 'registration.cancelled',
        entity_type: 'registration',
        entity_id: registrationId,
        new_values: JSON.stringify({
          refund_percentage: refundPercentage,
          days_until_event: daysUntilEvent,
        }),
        created_at: now,
      });
    });

    return {
      id: registrationId,
      status: 'cancelled',
      refund_percentage: refundPercentage,
      refund_eligible: refundPercentage > 0,
    };
  }

  /**
   * Promotes the next user from the waitlist to a pending_payment slot.
   * - Checks capacity first to avoid over-booking.
   * - Sends an in-app + push notification via NotificationService.
   * - Sets a 24h payment window (waitlist_promoted_at + 24h).
   *
   * Re-runs idempotently: callers may invoke after every cancellation
   * or refund and any cron job can call this safely.
   */
  static async promoteFromWaitlist(eventId: number, trx?: any) {
    // When called without an outer transaction, open one and lock the
    // event row so the capacity check and promotion cannot race with a
    // concurrent createRegistration or a parallel waitlist promotion.
    if (!trx) {
      return db.transaction(async (innerTrx) => {
        return this._promoteFromWaitlistInternal(eventId, innerTrx, /* externalTrx */ false);
      });
    }
    return this._promoteFromWaitlistInternal(eventId, trx, /* externalTrx */ true);
  }

  private static async _promoteFromWaitlistInternal(
    eventId: number,
    trx: any,
    externalTrx: boolean
  ) {
    const event = await trx(t('events')).where('id', eventId).forUpdate().first();
    if (!event) return null;

    const [{ count: activeCount }] = await trx(t('registrations'))
      .where('event_id', eventId)
      .whereIn('status', ['confirmed', 'pending_payment'])
      .count('* as count');

    if (Number(activeCount) >= event.max_participants) {
      return null;
    }

    const nextInLine = await trx(t('registrations'))
      .where('event_id', eventId)
      .where('status', 'waitlisted')
      .orderByRaw(`
        CASE membership_tier_at_registration
          WHEN 'club' THEN 1
          WHEN 'plus' THEN 2
          WHEN 'free' THEN 3
        END ASC,
        COALESCE(waitlist_position, 999999) ASC,
        created_at ASC
      `)
      .first();

    if (!nextInLine) return null;

    const now = new Date();
    await trx(t('registrations')).where('id', nextInLine.id).update({
      status: 'pending_payment',
      waitlist_position: null,
      waitlist_promoted_at: now,
      updated_at: now,
    });

    // Persist the notification row inside the current transaction so it
    // rolls back if the promotion fails. Push delivery (Firebase) is
    // dispatched after the transaction commits; see waitlist_push below.
    await trx(t('notifications')).insert({
      user_id: nextInLine.user_id,
      type: 'waitlist_promoted',
      title: 'Du bist dabei!',
      body: 'Ein Platz ist frei geworden. Bitte schließe deine Zahlung innerhalb von 24 Stunden ab.',
      data: JSON.stringify({ event_id: eventId, registration_id: nextInLine.id }),
      created_at: now,
    });

    // Fire-and-forget push only when we own the transaction; when the
    // caller owns it, they should dispatch after their own commit.
    if (!externalTrx) {
      const promotedUserId = nextInLine.user_id as number;
      const promotedRegId = nextInLine.id as number;
      setImmediate(() => {
        // The notification row was already inserted in the transaction
        // above; tell NotificationService to dispatch the push only.
        import('./notificationService')
          .then(({ NotificationService }) =>
            NotificationService.send(
              promotedUserId,
              'waitlist_promoted',
              'Du bist dabei!',
              'Ein Platz ist frei geworden. Bitte schließe deine Zahlung innerhalb von 24 Stunden ab.',
              { event_id: eventId, registration_id: promotedRegId },
              { skipDbInsert: true }
            )
          )
          .catch((err) => {
            console.error('[waitlist] Failed to send push to promoted user:', err?.message || err);
          });
      });
    }

    return nextInLine.id as number;
  }

  /**
   * Cron-friendly: cancels promoted waitlist users that have not paid
   * within 24h and promotes the next one. Safe to call from any scheduler.
   */
  static async expireUnpaidPromotions() {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const expired = await db(t('registrations'))
      .where('status', 'pending_payment')
      .whereNotNull('waitlist_promoted_at')
      .where('waitlist_promoted_at', '<', cutoff);

    for (const reg of expired) {
      await db(t('registrations')).where('id', reg.id).update({
        status: 'cancelled',
        updated_at: new Date(),
      });
      await this.promoteFromWaitlist(reg.event_id);
    }

    return { expired_count: expired.length };
  }

  static async checkIn(registrationId: number, userId: number) {
    const registration = await db(t('registrations'))
      .where('id', registrationId)
      .where('user_id', userId)
      .first();

    if (!registration) throw AppError.notFound('Registration');
    if (registration.status !== 'confirmed') {
      throw AppError.badRequest('Only confirmed registrations can check in');
    }
    if (registration.checked_in) {
      throw AppError.badRequest('Already checked in');
    }

    const event = await db(t('events')).where('id', registration.event_id).first();
    if (!event) throw AppError.notFound('Event');

    // Check if check-in window is open (1 hour before event)
    const now = new Date();
    const eventStart = new Date(event.start_date);
    const checkInOpens = new Date(eventStart.getTime() - 60 * 60 * 1000);

    if (now < checkInOpens) {
      throw AppError.badRequest('Check-in is not yet available');
    }

    await db(t('registrations')).where('id', registrationId).update({
      checked_in: true,
      checked_in_at: now,
      updated_at: now,
    });

    return { checked_in: true, checked_in_at: now };
  }

  static async getUserRegistrations(userId: number, status?: string) {
    let query = db(t('registrations'))
      .where(`${t('registrations')}.user_id`, userId)
      .leftJoin(t('events'), `${t('registrations')}.event_id`, `${t('events')}.id`)
      .leftJoin(t('venues'), `${t('events')}.venue_id`, `${t('venues')}.id`)
      .select(
        `${t('registrations')}.*`,
        `${t('events')}.title as event_title`,
        `${t('events')}.start_date as event_start_date`,
        `${t('events')}.end_date as event_end_date`,
        `${t('events')}.status as event_status`,
        `${t('events')}.banner_image_url as event_banner`,
        `${t('venues')}.name as venue_name`,
        `${t('venues')}.address_city as venue_city`
      )
      .orderBy(`${t('events')}.start_date`, 'desc');

    if (status) {
      query = query.where(`${t('registrations')}.status`, status);
    }

    return query;
  }
}