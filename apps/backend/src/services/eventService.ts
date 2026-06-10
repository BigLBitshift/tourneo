import { v4 as uuidv4 } from 'uuid';
import { db, t } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { CreateEventInput, EventFiltersInput } from '../validators/events';
import { MembershipTier } from '../types';
import dayjs from 'dayjs';

export class EventService {
  static async createEvent(input: CreateEventInput, createdBy: number) {
    const eventUuid = uuidv4();
    const now = new Date();

    // Calculate early access windows
    const registrationOpensAt = new Date(input.registration_opens_at);
    const clubEarlyAccess = new Date(registrationOpensAt.getTime() - 48 * 60 * 60 * 1000);
    const plusEarlyAccess = new Date(registrationOpensAt.getTime() - 24 * 60 * 60 * 1000);

    const result = await db.transaction(async (trx) => {
      const [eventId] = await trx(t('events')).insert({
        uuid: eventUuid,
        title: input.title,
        description: input.description || null,
        sport_category: input.sport_category,
        event_type: input.event_type,
        venue_id: input.venue_id,
        start_date: input.start_date,
        end_date: input.end_date,
        registration_opens_at: input.registration_opens_at,
        registration_closes_at: input.registration_closes_at,
        club_early_access_at: clubEarlyAccess,
        plus_early_access_at: plusEarlyAccess,
        is_indoor: input.is_indoor,
        is_outdoor: input.is_outdoor,
        format: input.format,
        elimination_type: input.elimination_type,
        has_third_place_match: input.has_third_place_match,
        max_participants: input.max_participants,
        entry_fee_cents: input.entry_fee_cents,
        currency: input.currency,
        total_prize_pool_cents: input.total_prize_pool_cents,
        level: input.level,
        access_type: input.access_type,
        has_food_drinks: input.has_food_drinks,
        has_streaming: input.has_streaming,
        special_notes: input.special_notes || null,
        rules_summary: input.rules_summary || null,
        banner_image_url: input.banner_image_url || null,
        sponsor_name: input.sponsor_name || null,
        sponsor_logo_url: input.sponsor_logo_url || null,
        sponsor_website_url: input.sponsor_website_url || null,
        invite_token: input.access_type === 'private' ? uuidv4() : null,
        status: 'draft',
        created_by: createdBy,
        created_at: now,
        updated_at: now,
      });

      // Insert prize distribution
      if (input.prize_distribution && input.prize_distribution.length > 0) {
        const prizeRows = input.prize_distribution.map((p) => ({
          event_id: eventId,
          place: p.place,
          amount_cents: p.amount_cents,
          currency: input.currency,
          label: p.label || null,
        }));
        await trx(t('prize_distributions')).insert(prizeRows);
      }

      // Audit log
      await trx(t('audit_log')).insert({
        user_id: createdBy,
        action: 'event.created',
        entity_type: 'event',
        entity_id: eventId,
        new_values: JSON.stringify({ title: input.title, status: 'draft' }),
        created_at: now,
      });

      return eventId;
    });

    return this.getEventById(result);
  }

  static async getEventById(eventId: number) {
    const event = await db(t('events'))
      .where(`${t('events')}.id`, eventId)
      .leftJoin(t('venues'), `${t('events')}.venue_id`, `${t('venues')}.id`)
      .select(
        `${t('events')}.*`,
        `${t('venues')}.name as venue_name`,
        `${t('venues')}.address_street as venue_street`,
        `${t('venues')}.address_city as venue_city`,
        `${t('venues')}.address_zip as venue_zip`,
        `${t('venues')}.address_country as venue_country`,
        `${t('venues')}.latitude as venue_latitude`,
        `${t('venues')}.longitude as venue_longitude`,
        `${t('venues')}.image_url as venue_image_url`
      )
      .first();

    if (!event) {
      throw AppError.notFound('Event');
    }

    // Get participant count
    const [{ count: participantCount }] = await db(t('registrations'))
      .where('event_id', eventId)
      .whereIn('status', ['confirmed', 'pending_payment'])
      .count('* as count');

    // Get prize distribution
    const prizeDistribution = await db(t('prize_distributions'))
      .where('event_id', eventId)
      .orderBy('place', 'asc');

    return {
      ...event,
      participant_count: Number(participantCount),
      spots_remaining: event.max_participants - Number(participantCount),
      prize_distribution: prizeDistribution,
      venue: {
        id: event.venue_id,
        name: event.venue_name,
        address_street: event.venue_street,
        address_city: event.venue_city,
        address_zip: event.venue_zip,
        address_country: event.venue_country,
        latitude: event.venue_latitude,
        longitude: event.venue_longitude,
        image_url: event.venue_image_url,
      },
    };
  }

  static async listEvents(filters: EventFiltersInput) {
    let query = db(t('events'))
      .leftJoin(t('venues'), `${t('events')}.venue_id`, `${t('venues')}.id`)
      .select(
        `${t('events')}.*`,
        `${t('venues')}.name as venue_name`,
        `${t('venues')}.address_city as venue_city`,
        `${t('venues')}.latitude as venue_latitude`,
        `${t('venues')}.longitude as venue_longitude`
      )
      .where(`${t('events')}.status`, '!=', 'draft');

    // Apply filters
    if (filters.sport_category) {
      query = query.where(`${t('events')}.sport_category`, filters.sport_category);
    }
    if (filters.city) {
      // Escape LIKE wildcards in user input so a city of "Berlin%" doesn't
      // match every city containing "Berlin".
      const escaped = filters.city.replace(/[\\%_]/g, (m) => `\\${m}`);
      query = query.where(`${t('venues')}.address_city`, 'LIKE', `%${escaped}%`);
    }
    if (filters.date_from) {
      query = query.where(`${t('events')}.start_date`, '>=', filters.date_from);
    }
    if (filters.date_to) {
      query = query.where(`${t('events')}.start_date`, '<=', filters.date_to);
    }
    if (filters.is_indoor !== undefined) {
      query = query.where(`${t('events')}.is_indoor`, filters.is_indoor);
    }
    if (filters.is_outdoor !== undefined) {
      query = query.where(`${t('events')}.is_outdoor`, filters.is_outdoor);
    }
    if (filters.min_fee !== undefined) {
      query = query.where(`${t('events')}.entry_fee_cents`, '>=', filters.min_fee);
    }
    if (filters.max_fee !== undefined) {
      query = query.where(`${t('events')}.entry_fee_cents`, '<=', filters.max_fee);
    }
    if (filters.level) {
      query = query.where(`${t('events')}.level`, filters.level);
    }
    if (filters.status) {
      query = query.where(`${t('events')}.status`, filters.status);
    }
    if (filters.access_type) {
      query = query.where(`${t('events')}.access_type`, filters.access_type);
    }

    // Count total
    const countQuery = query.clone();
    const [{ count: total }] = await countQuery.count('* as count');

    // Sort
    const sortColumn = {
      date: `${t('events')}.start_date`,
      price: `${t('events')}.entry_fee_cents`,
      prize: `${t('events')}.total_prize_pool_cents`,
      created: `${t('events')}.created_at`,
    }[filters.sort_by];

    query = query.orderBy(sortColumn, filters.sort_order);

    // Paginate
    const offset = (filters.page - 1) * filters.per_page;
    query = query.limit(filters.per_page).offset(offset);

    const events = await query;

    // Get participant counts for all events
    const eventIds = events.map((e: any) => e.id);
    const participantCounts = await db(t('registrations'))
      .whereIn('event_id', eventIds)
      .whereIn('status', ['confirmed', 'pending_payment'])
      .groupBy('event_id')
      .select('event_id')
      .count('* as count');

    const countMap = new Map(participantCounts.map((pc: any) => [pc.event_id, Number(pc.count)]));

    const enrichedEvents = events.map((event: any) => ({
      ...event,
      participant_count: countMap.get(event.id) || 0,
      spots_remaining: event.max_participants - (countMap.get(event.id) || 0),
      venue: {
        name: event.venue_name,
        city: event.venue_city,
      },
    }));

    return {
      data: enrichedEvents,
      meta: {
        page: filters.page,
        per_page: filters.per_page,
        total: Number(total),
        total_pages: Math.ceil(Number(total) / filters.per_page),
      },
    };
  }

  static async publishEvent(eventId: number, userId: number) {
    const event = await db(t('events')).where('id', eventId).first();
    if (!event) throw AppError.notFound('Event');
    if (event.status !== 'draft') {
      throw AppError.badRequest('Only draft events can be published');
    }

    const now = new Date();
    let newStatus = 'published';

    // If registration window is already open, set status accordingly
    if (new Date(event.registration_opens_at) <= now && new Date(event.registration_closes_at) > now) {
      newStatus = 'registration_open';
    }

    await db(t('events')).where('id', eventId).update({
      status: newStatus,
      published_at: now,
      updated_at: now,
    });

    await db(t('audit_log')).insert({
      user_id: userId,
      action: 'event.published',
      entity_type: 'event',
      entity_id: eventId,
      new_values: JSON.stringify({ status: newStatus }),
      created_at: now,
    });

    // Fan-out notifications to all active users (best-effort, async-safe)
    try {
      const { NotificationService } = await import('./notificationService');
      await NotificationService.notifyEventPublished(eventId);
    } catch (err) {
      console.error('[events] Failed to fan-out publish notifications:', err);
    }

    return this.getEventById(eventId);
  }

  static async cancelEvent(eventId: number, userId: number) {
    const event = await db(t('events')).where('id', eventId).first();
    if (!event) throw AppError.notFound('Event');
    if (event.status === 'completed' || event.status === 'cancelled') {
      throw AppError.badRequest('Event is already completed or cancelled');
    }

    await db.transaction(async (trx) => {
      await trx(t('events')).where('id', eventId).update({
        status: 'cancelled',
        updated_at: new Date(),
      });

      // Mark all confirmed registrations for refund
      await trx(t('registrations'))
        .where('event_id', eventId)
        .whereIn('status', ['confirmed', 'waitlisted'])
        .update({ status: 'cancelled', updated_at: new Date() });

      await trx(t('audit_log')).insert({
        user_id: userId,
        action: 'event.cancelled',
        entity_type: 'event',
        entity_id: eventId,
        created_at: new Date(),
      });
    });

    return this.getEventById(eventId);
  }

  static canUserRegister(
    event: any,
    membershipTier: MembershipTier,
    inviteToken?: string
  ): { canRegister: boolean; reason?: string; opensAt?: Date } {
    const now = new Date();

    if (event.status === 'cancelled' || event.status === 'completed') {
      return { canRegister: false, reason: 'Event is no longer accepting registrations' };
    }

    // Private events are invite-only: the registration must carry the
    // event's invite token (shared as a link by the organiser).
    if (event.access_type === 'private') {
      if (!inviteToken || !event.invite_token || inviteToken !== event.invite_token) {
        return { canRegister: false, reason: 'This is a private event — an invite link is required' };
      }
    }

    if (new Date(event.registration_closes_at) < now) {
      return { canRegister: false, reason: 'Registration deadline has passed' };
    }

    // Check access type
    if (event.access_type === 'club_only' && membershipTier !== 'club') {
      return { canRegister: false, reason: 'This event is exclusive to Club members' };
    }
    if (event.access_type === 'members_only' && membershipTier === 'free') {
      return { canRegister: false, reason: 'This event is exclusive to members' };
    }

    // Determine the earliest moment this tier is allowed to register.
    // Higher tiers fall back to the regular open date when their early-
    // access window is missing or accidentally set later than the
    // public open. The minimum guarantees we never block a member who
    // could already register through the public window.
    const regularOpensAt = new Date(event.registration_opens_at);
    const tierOpensAt = ((): Date => {
      if (membershipTier === 'club' && event.club_early_access_at) {
        const club = new Date(event.club_early_access_at);
        return club < regularOpensAt ? club : regularOpensAt;
      }
      if (membershipTier === 'plus' && event.plus_early_access_at) {
        const plus = new Date(event.plus_early_access_at);
        return plus < regularOpensAt ? plus : regularOpensAt;
      }
      return regularOpensAt;
    })();

    if (tierOpensAt <= now) {
      return { canRegister: true };
    }

    const usedEarlyWindow = tierOpensAt.getTime() < regularOpensAt.getTime();
    let reason = 'Registration not yet open';
    if (usedEarlyWindow && membershipTier === 'club') {
      reason = 'Club early access opens soon';
    } else if (usedEarlyWindow && membershipTier === 'plus') {
      reason = 'Registration opens for Plus members soon';
    }

    return {
      canRegister: false,
      reason,
      opensAt: tierOpensAt,
    };
  }

  static calculateDiscountedFee(feeInCents: number, membershipTier: MembershipTier): { fee: number; discount: number } {
    let discountPercent = 0;
    if (membershipTier === 'plus') discountPercent = 10;
    if (membershipTier === 'club') discountPercent = 20;

    const discount = Math.round(feeInCents * (discountPercent / 100));
    return {
      fee: feeInCents - discount,
      discount,
    };
  }
}