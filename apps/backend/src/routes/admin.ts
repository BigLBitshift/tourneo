import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { authenticate, adminOnly, superadminOnly } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { PaymentController } from '../controllers/paymentController';
import { AuditService } from '../services/auditService';
import { PlaytomicService } from '../services/playtomicService';
import { CourtAvailabilityService } from '../services/courtAvailabilityService';
import { db, t } from '../config/database';
import { AppError } from '../middleware/errorHandler';

// ──────────────────────────────────────────────
// Shared Zod schemas for admin mutations (8a)
// ──────────────────────────────────────────────
const userRoleSchema = z.object({
  role: z.enum(['user', 'admin', 'superadmin']),
});
const userStatusSchema = z.object({
  status: z.enum(['active', 'suspended', 'deleted']),
});
const refundDecisionSchema = z.object({
  reason: z.string().min(1).max(500).optional(),
});
const createRefundSchema = z.object({
  payment_id: z.number().int().positive(),
  amount_cents: z.number().int().positive(),
  reason: z.enum([
    'user_cancellation_14d',
    'organizer_cancellation',
    'admin_decision',
    'duplicate',
    'other',
  ]),
  reason_detail: z.string().max(1000).optional(),
});
const notifyParticipantsSchema = z.object({
  subject: z.string().min(1).max(255),
  body: z.string().min(1).max(5000),
  target: z
    .enum(['all_participants', 'confirmed_only', 'waitlisted_only', 'all_users'])
    .default('all_participants'),
});
const matchResultSchema = z.object({
  winner_registration_id: z.number().int().positive(),
  score: z.string().min(1).max(255).optional(),
  notes: z.string().max(2000).optional(),
});

const router = Router();

// All admin routes require authentication + admin role
router.use(authenticate, adminOnly);

// ============================================================
// 1. DASHBOARD STATS
// ============================================================

router.get('/stats/overview', PaymentController.getAdminStats);

router.get('/stats/events', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [counts] = await db(t('events'))
      .select(
        db.raw(`SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) as draft`),
        db.raw(`SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) as published`),
        db.raw(`SUM(CASE WHEN status = 'registration_open' THEN 1 ELSE 0 END) as registration_open`),
        db.raw(`SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress`),
        db.raw(`SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed`),
        db.raw(`SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled`),
        db.raw(`SUM(CASE WHEN is_archived = true THEN 1 ELSE 0 END) as archived`),
        db.raw('COUNT(*) as total')
      );

    res.json({ success: true, data: counts });
  } catch (error) {
    next(error);
  }
});

router.get('/stats/revenue', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { period = '30d' } = req.query;
    let dateFilter = new Date();
    if (period === '7d') dateFilter.setDate(dateFilter.getDate() - 7);
    else if (period === '30d') dateFilter.setDate(dateFilter.getDate() - 30);
    else if (period === '90d') dateFilter.setDate(dateFilter.getDate() - 90);
    else dateFilter.setFullYear(dateFilter.getFullYear() - 1);

    const revenue = await db(t('payments'))
      .where('status', 'succeeded')
      .where('paid_at', '>=', dateFilter)
      .select(
        db.raw('DATE(paid_at) as date'),
        db.raw('SUM(net_amount_cents) as revenue'),
        db.raw('COUNT(*) as transactions')
      )
      .groupByRaw('DATE(paid_at)')
      .orderBy('date', 'asc');

    res.json({ success: true, data: revenue });
  } catch (error) {
    next(error);
  }
});

router.get('/stats/members', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const members = await db(t('memberships'))
      .where('status', 'active')
      .select('tier')
      .count('* as count')
      .groupBy('tier');

    res.json({ success: true, data: members });
  } catch (error) {
    next(error);
  }
});

// ============================================================
// 2. EVENT MANAGEMENT (CRUD + Advanced)
// ============================================================

// List all events (including drafts, archived) for admin
router.get('/events', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page = 1, per_page = 20, status, sport_category, search, include_archived } = req.query;

    let query = db(t('events'))
      .leftJoin(t('venues'), `${t('events')}.venue_id`, `${t('venues')}.id`)
      .select(
        `${t('events')}.*`,
        `${t('venues')}.name as venue_name`,
        `${t('venues')}.address_city as venue_city`
      );

    if (!include_archived) {
      query = query.where(function () {
        this.where(`${t('events')}.is_archived`, false).orWhereNull(`${t('events')}.is_archived`);
      });
    }
    if (status) query = query.where(`${t('events')}.status`, status as string);
    if (sport_category) query = query.where(`${t('events')}.sport_category`, sport_category as string);
    if (search) {
      query = query.where(`${t('events')}.title`, 'LIKE', `%${search}%`);
    }

    const countQuery = query.clone();
    const [{ count: total }] = await countQuery.count('* as count');
    const offset = (Number(page) - 1) * Number(per_page);

    const events = await query
      .orderBy(`${t('events')}.created_at`, 'desc')
      .limit(Number(per_page))
      .offset(offset);

    const eventIds = events.map((e: any) => e.id);
    const participantCounts = eventIds.length
      ? await db(t('registrations'))
          .whereIn('event_id', eventIds)
          .whereIn('status', ['confirmed', 'pending_payment'])
          .groupBy('event_id')
          .select('event_id')
          .count('* as count')
      : [];

    const countMap = new Map(participantCounts.map((pc: any) => [pc.event_id, Number(pc.count)]));

    const enrichedEvents = events.map((event: any) => ({
      ...event,
      participant_count: countMap.get(event.id) || 0,
      spots_remaining: event.max_participants - (countMap.get(event.id) || 0),
    }));

    res.json({
      success: true,
      data: enrichedEvents,
      meta: {
        page: Number(page),
        per_page: Number(per_page),
        total: Number(total),
        total_pages: Math.ceil(Number(total) / Number(per_page)),
      },
    });
  } catch (error) {
    next(error);
  }
});

// Get single event with full admin details
router.get('/events/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const eventId = parseInt(req.params.id, 10);
    const event = await db(t('events'))
      .where(`${t('events')}.id`, eventId)
      .leftJoin(t('venues'), `${t('events')}.venue_id`, `${t('venues')}.id`)
      .select(`${t('events')}.*`, `${t('venues')}.name as venue_name`, `${t('venues')}.address_city as venue_city`)
      .first();

    if (!event) throw AppError.notFound('Event');

    // Participant stats
    const registrationStats = await db(t('registrations'))
      .where('event_id', eventId)
      .select('status')
      .count('* as count')
      .groupBy('status');

    // Checkin stats
    const [{ count: checkedInCount }] = await db(t('registrations'))
      .where('event_id', eventId)
      .where('checked_in', true)
      .count('* as count');

    // Revenue for this event
    const [revenueData] = await db(t('payments'))
      .leftJoin(t('registrations'), `${t('payments')}.registration_id`, `${t('registrations')}.id`)
      .where(`${t('registrations')}.event_id`, eventId)
      .where(`${t('payments')}.status`, 'succeeded')
      .select(
        db.raw('SUM(net_amount_cents) as total_revenue'),
        db.raw('COUNT(*) as payment_count')
      );

    // Prize distribution
    const prizes = await db(t('prize_distributions'))
      .where('event_id', eventId)
      .orderBy('place', 'asc');

    res.json({
      success: true,
      data: {
        ...event,
        faq: event.faq ? JSON.parse(event.faq) : [],
        prize_table: event.prize_table ? JSON.parse(event.prize_table) : null,
        registration_stats: registrationStats,
        checked_in_count: Number(checkedInCount),
        revenue: revenueData,
        prize_distribution: prizes,
      },
    });
  } catch (error) {
    next(error);
  }
});

// Update event (full content management: notes, rules, FAQ, venue hints, etc.)
router.put('/events/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const eventId = parseInt(req.params.id, 10);
    const event = await db(t('events')).where('id', eventId).first();
    if (!event) throw AppError.notFound('Event');

    const allowedFields = [
      'title', 'description', 'sport_category', 'event_type', 'venue_id',
      'start_date', 'end_date', 'registration_opens_at', 'registration_closes_at',
      'is_indoor', 'is_outdoor', 'format', 'elimination_type', 'has_third_place_match',
      'max_participants', 'entry_fee_cents', 'currency', 'total_prize_pool_cents',
      'level', 'access_type', 'has_food_drinks', 'has_streaming',
      'special_notes', 'rules_summary', 'rules_full', 'banner_image_url',
      'faq', 'venue_hints', 'prize_table', 'streaming_url',
    ];

    const updates: Record<string, any> = {};
    const before: Record<string, any> = {};

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        before[field] = event[field];
        if (['faq', 'venue_hints', 'prize_table'].includes(field) && typeof req.body[field] === 'object') {
          updates[field] = JSON.stringify(req.body[field]);
        } else {
          updates[field] = req.body[field];
        }
      }
    }

    if (Object.keys(updates).length === 0) {
      throw AppError.badRequest('No valid fields to update');
    }

    updates.updated_at = new Date();
    await db(t('events')).where('id', eventId).update(updates);

    await AuditService.logFromRequest(req, 'event.updated', 'event', eventId, {
      resourceLabel: event.title,
      changes: { before, after: updates },
    });

    const updated = await db(t('events')).where('id', eventId).first();
    res.json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
});

// Duplicate event
router.post('/events/:id/duplicate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const eventId = parseInt(req.params.id, 10);
    const original = await db(t('events')).where('id', eventId).first();
    if (!original) throw AppError.notFound('Event');

    const now = new Date();
    const newUuid = uuidv4();
    const { title_suffix = ' (Kopie)' } = req.body;

    const {
      id: _id, uuid: _uuid, status: _status, created_at: _ca, updated_at: _ua,
      published_at: _pa, archived_at: _aa, is_archived: _ia,
      ...eventData
    } = original;

    const [newEventId] = await db(t('events')).insert({
      ...eventData,
      uuid: newUuid,
      title: original.title + title_suffix,
      status: 'draft',
      duplicated_from_id: eventId,
      is_archived: false,
      archived_at: null,
      published_at: null,
      created_by: req.user!.userId,
      created_at: now,
      updated_at: now,
    });

    // Duplicate prize distribution
    const prizes = await db(t('prize_distributions')).where('event_id', eventId);
    if (prizes.length > 0) {
      await db(t('prize_distributions')).insert(
        prizes.map((p: any) => ({
          event_id: newEventId,
          place: p.place,
          amount_cents: p.amount_cents,
          currency: p.currency,
          label: p.label,
        }))
      );
    }

    await AuditService.logFromRequest(req, 'event.duplicated', 'event', newEventId, {
      resourceLabel: original.title + title_suffix,
      metadata: { duplicated_from: eventId },
    });

    const newEvent = await db(t('events')).where('id', newEventId).first();
    res.status(201).json({ success: true, data: newEvent });
  } catch (error) {
    next(error);
  }
});

// Archive event
router.put('/events/:id/archive', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const eventId = parseInt(req.params.id, 10);
    const event = await db(t('events')).where('id', eventId).first();
    if (!event) throw AppError.notFound('Event');

    const now = new Date();
    await db(t('events')).where('id', eventId).update({
      is_archived: true,
      archived_at: now,
      updated_at: now,
    });

    await AuditService.logFromRequest(req, 'event.archived', 'event', eventId, {
      resourceLabel: event.title,
    });

    res.json({ success: true, data: { message: 'Event archived', event_id: eventId } });
  } catch (error) {
    next(error);
  }
});

// Unarchive event
router.put('/events/:id/unarchive', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const eventId = parseInt(req.params.id, 10);
    const event = await db(t('events')).where('id', eventId).first();
    if (!event) throw AppError.notFound('Event');

    await db(t('events')).where('id', eventId).update({
      is_archived: false,
      archived_at: null,
      updated_at: new Date(),
    });

    await AuditService.logFromRequest(req, 'event.unarchived', 'event', eventId, {
      resourceLabel: event.title,
    });

    res.json({ success: true, data: { message: 'Event unarchived', event_id: eventId } });
  } catch (error) {
    next(error);
  }
});

// Unpublish event (back to draft)
router.put('/events/:id/unpublish', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const eventId = parseInt(req.params.id, 10);
    const event = await db(t('events')).where('id', eventId).first();
    if (!event) throw AppError.notFound('Event');

    if (!['published', 'registration_open'].includes(event.status)) {
      throw AppError.badRequest('Only published or registration_open events can be unpublished');
    }

    const [{ count: confirmedCount }] = await db(t('registrations'))
      .where('event_id', eventId)
      .whereIn('status', ['confirmed', 'pending_payment'])
      .count('* as count');

    if (Number(confirmedCount) > 0) {
      throw AppError.badRequest(
        `Cannot unpublish: ${confirmedCount} active registrations exist. Cancel registrations first or cancel the event.`
      );
    }

    const now = new Date();
    await db(t('events')).where('id', eventId).update({
      status: 'draft',
      published_at: null,
      updated_at: now,
    });

    await AuditService.logFromRequest(req, 'event.unpublished', 'event', eventId, {
      resourceLabel: event.title,
      changes: { before: { status: event.status }, after: { status: 'draft' } },
    });

    res.json({ success: true, data: { message: 'Event unpublished', event_id: eventId } });
  } catch (error) {
    next(error);
  }
});

// ============================================================
// 3. PARTICIPANT MANAGEMENT
// ============================================================

// List participants for an event
router.get('/events/:id/participants', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const eventId = parseInt(req.params.id, 10);
    const { status, search } = req.query;

    let query = db(t('registrations'))
      .where(`${t('registrations')}.event_id`, eventId)
      .leftJoin(t('users'), `${t('registrations')}.user_id`, `${t('users')}.id`)
      .leftJoin(t('profiles'), `${t('registrations')}.user_id`, `${t('profiles')}.user_id`)
      .select(
        `${t('registrations')}.*`,
        `${t('users')}.email`,
        `${t('profiles')}.first_name`,
        `${t('profiles')}.last_name`,
        `${t('profiles')}.display_name`,
        `${t('profiles')}.phone`,
        `${t('profiles')}.avatar_url`
      );

    if (status) query = query.where(`${t('registrations')}.status`, status as string);
    if (search) {
      query = query.where(function () {
        this.where(`${t('users')}.email`, 'LIKE', `%${search}%`)
          .orWhere(`${t('profiles')}.first_name`, 'LIKE', `%${search}%`)
          .orWhere(`${t('profiles')}.last_name`, 'LIKE', `%${search}%`);
      });
    }

    const participants = await query.orderBy(`${t('registrations')}.created_at`, 'asc');

    res.json({ success: true, data: participants });
  } catch (error) {
    next(error);
  }
});

// Manually add participant to event
router.post('/events/:id/participants', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const eventId = parseInt(req.params.id, 10);
    const { user_id, registration_type = 'solo', skip_payment = false, notes } = req.body;

    const event = await db(t('events')).where('id', eventId).first();
    if (!event) throw AppError.notFound('Event');

    const user = await db(t('users')).where('id', user_id).first();
    if (!user) throw AppError.notFound('User');

    const existing = await db(t('registrations'))
      .where('event_id', eventId)
      .where('user_id', user_id)
      .whereNotIn('status', ['cancelled', 'refunded'])
      .first();

    if (existing) throw AppError.conflict('User already registered for this event');

    const [{ count: currentCount }] = await db(t('registrations'))
      .where('event_id', eventId)
      .whereIn('status', ['confirmed', 'pending_payment'])
      .count('* as count');

    const isFull = Number(currentCount) >= event.max_participants;

    const now = new Date();
    const regUuid = uuidv4();
    let status = skip_payment ? 'confirmed' : 'pending_payment';
    let waitlistPosition: number | null = null;

    if (isFull && !skip_payment) {
      const [{ maxPos }] = await db(t('registrations'))
        .where('event_id', eventId)
        .where('status', 'waitlisted')
        .max('waitlist_position as maxPos');
      waitlistPosition = (maxPos || 0) + 1;
      status = 'waitlisted';
    }

    const [registrationId] = await db(t('registrations')).insert({
      uuid: regUuid,
      event_id: eventId,
      user_id,
      registration_type,
      status,
      membership_tier_at_registration: 'free',
      discount_applied_cents: 0,
      consent_tournament_terms: true,
      consent_age_verified: true,
      consent_media: true,
      waitlist_position: waitlistPosition,
      created_at: now,
      updated_at: now,
    });

    await AuditService.logFromRequest(req, 'participant.added_manually', 'registration', registrationId, {
      resourceLabel: `User ${user_id} → Event ${event.title}`,
      metadata: { user_id, event_id: eventId, skip_payment, notes },
    });

    res.status(201).json({
      success: true,
      data: { registration_id: registrationId, status, waitlist_position: waitlistPosition },
    });
  } catch (error) {
    next(error);
  }
});

// Remove participant from event
router.delete('/events/:id/participants/:regId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const eventId = parseInt(req.params.id, 10);
    const regId = parseInt(req.params.regId, 10);
    const { reason } = req.body || {};

    const registration = await db(t('registrations'))
      .where('id', regId)
      .where('event_id', eventId)
      .first();

    if (!registration) throw AppError.notFound('Registration');

    const now = new Date();
    await db(t('registrations')).where('id', regId).update({
      status: 'cancelled',
      updated_at: now,
    });

    if (registration.status === 'confirmed') {
      const nextInLine = await db(t('registrations'))
        .where('event_id', eventId)
        .where('status', 'waitlisted')
        .orderBy('waitlist_position', 'asc')
        .first();

      if (nextInLine) {
        await db(t('registrations')).where('id', nextInLine.id).update({
          status: 'pending_payment',
          waitlist_position: null,
          waitlist_promoted_at: now,
          updated_at: now,
        });

        await db(t('notifications')).insert({
          user_id: nextInLine.user_id,
          type: 'waitlist_promoted',
          title: 'Du bist dabei!',
          body: 'Ein Platz ist frei geworden. Bitte schließe deine Zahlung ab.',
          data: JSON.stringify({ event_id: eventId, registration_id: nextInLine.id }),
          created_at: now,
        });
      }
    }

    await AuditService.logFromRequest(req, 'participant.removed', 'registration', regId, {
      resourceLabel: `Registration ${regId} from Event ${eventId}`,
      metadata: { reason, previous_status: registration.status },
    });

    res.json({ success: true, data: { message: 'Participant removed' } });
  } catch (error) {
    next(error);
  }
});

// Reorder waitlist
router.put('/events/:id/waitlist/reorder', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const eventId = parseInt(req.params.id, 10);
    const { order } = req.body;

    if (!Array.isArray(order)) throw AppError.badRequest('order must be an array');

    await db.transaction(async (trx) => {
      for (const item of order) {
        await trx(t('registrations'))
          .where('id', item.registration_id)
          .where('event_id', eventId)
          .where('status', 'waitlisted')
          .update({
            waitlist_position: item.position,
            updated_at: new Date(),
          });
      }
    });

    await AuditService.logFromRequest(req, 'waitlist.reordered', 'event', eventId, {
      metadata: { new_order: order },
    });

    res.json({ success: true, data: { message: 'Waitlist reordered' } });
  } catch (error) {
    next(error);
  }
});

// Promote from waitlist manually
router.put('/events/:id/waitlist/:regId/promote', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const eventId = parseInt(req.params.id, 10);
    const regId = parseInt(req.params.regId, 10);

    const registration = await db(t('registrations'))
      .where('id', regId)
      .where('event_id', eventId)
      .where('status', 'waitlisted')
      .first();

    if (!registration) throw AppError.notFound('Waitlisted registration');

    const now = new Date();
    await db(t('registrations')).where('id', regId).update({
      status: 'pending_payment',
      waitlist_position: null,
      waitlist_promoted_at: now,
      updated_at: now,
    });

    await db(t('notifications')).insert({
      user_id: registration.user_id,
      type: 'waitlist_promoted',
      title: 'Du bist dabei!',
      body: 'Du wurdest vom Veranstalter manuell aufgenommen. Bitte schließe deine Zahlung ab.',
      data: JSON.stringify({ event_id: eventId, registration_id: regId }),
      created_at: now,
    });

    await AuditService.logFromRequest(req, 'waitlist.promoted_manually', 'registration', regId, {
      metadata: { event_id: eventId },
    });

    res.json({ success: true, data: { message: 'Participant promoted from waitlist' } });
  } catch (error) {
    next(error);
  }
});

// ============================================================
// 4. CHECK-IN MANAGEMENT
// ============================================================

// Admin check-in a participant
router.post('/events/:id/checkin/:regId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const eventId = parseInt(req.params.id, 10);
    const regId = parseInt(req.params.regId, 10);
    const { method = 'manual', notes } = req.body || {};

    const registration = await db(t('registrations'))
      .where('id', regId)
      .where('event_id', eventId)
      .first();

    if (!registration) throw AppError.notFound('Registration');
    if (registration.status !== 'confirmed') {
      throw AppError.badRequest('Only confirmed participants can be checked in');
    }
    if (registration.checked_in) {
      throw AppError.badRequest('Already checked in');
    }

    const now = new Date();
    await db.transaction(async (trx) => {
      await trx(t('registrations')).where('id', regId).update({
        checked_in: true,
        checked_in_at: now,
        updated_at: now,
      });

      await trx(t('checkins')).insert({
        registration_id: regId,
        checked_in_by: req.user!.userId,
        checked_in_at: now,
        method,
        notes: notes || null,
        created_at: now,
      });
    });

    await AuditService.logFromRequest(req, 'checkin.admin', 'registration', regId, {
      metadata: { event_id: eventId, method, notes },
    });

    res.json({ success: true, data: { message: 'Participant checked in', registration_id: regId } });
  } catch (error) {
    next(error);
  }
});

// Undo check-in
router.delete('/events/:id/checkin/:regId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const eventId = parseInt(req.params.id, 10);
    const regId = parseInt(req.params.regId, 10);

    const registration = await db(t('registrations'))
      .where('id', regId)
      .where('event_id', eventId)
      .first();

    if (!registration) throw AppError.notFound('Registration');
    if (!registration.checked_in) throw AppError.badRequest('Not checked in');

    await db.transaction(async (trx) => {
      await trx(t('registrations')).where('id', regId).update({
        checked_in: false,
        checked_in_at: null,
        updated_at: new Date(),
      });

      await trx(t('checkins')).where('registration_id', regId).del();
    });

    await AuditService.logFromRequest(req, 'checkin.undone', 'registration', regId, {
      metadata: { event_id: eventId },
    });

    res.json({ success: true, data: { message: 'Check-in undone' } });
  } catch (error) {
    next(error);
  }
});

// Bulk check-in status for event
router.get('/events/:id/checkin-status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const eventId = parseInt(req.params.id, 10);

    const participants = await db(t('registrations'))
      .where(`${t('registrations')}.event_id`, eventId)
      .where(`${t('registrations')}.status`, 'confirmed')
      .leftJoin(t('profiles'), `${t('registrations')}.user_id`, `${t('profiles')}.user_id`)
      .select(
        `${t('registrations')}.id`,
        `${t('registrations')}.user_id`,
        `${t('registrations')}.checked_in`,
        `${t('registrations')}.checked_in_at`,
        `${t('registrations')}.seed_number`,
        `${t('profiles')}.first_name`,
        `${t('profiles')}.last_name`,
        `${t('profiles')}.display_name`
      )
      .orderBy(`${t('registrations')}.seed_number`, 'asc');

    const total = participants.length;
    const checkedIn = participants.filter((p: any) => p.checked_in).length;

    res.json({
      success: true,
      data: {
        total,
        checked_in: checkedIn,
        remaining: total - checkedIn,
        participants,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ============================================================
// 5. RESULT ENTRY & CORRECTION
// ============================================================

// Enter/update match result
router.put('/matches/:matchId/result', validateBody(matchResultSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const matchId = parseInt(req.params.matchId, 10);
    const { scores, winner_registration_id, notes } = req.body;

    const match = await db(t('matches')).where('id', matchId).first();
    if (!match) throw AppError.notFound('Match');

    const before = {
      status: match.status,
      winner_registration_id: match.winner_registration_id,
    };

    const now = new Date();
    const updates: Record<string, any> = {
      updated_at: now,
    };

    if (winner_registration_id) {
      updates.winner_registration_id = winner_registration_id;
      updates.status = 'completed';
      updates.completed_at = now;
    }

    await db(t('matches')).where('id', matchId).update(updates);

    // Save scores
    if (scores && Array.isArray(scores)) {
      await db(t('match_scores')).where('match_id', matchId).del();

      for (const score of scores) {
        await db(t('match_scores')).insert({
          match_id: matchId,
          set_number: score.set_number,
          participant_1_score: score.participant_1_score,
          participant_2_score: score.participant_2_score,
          created_at: now,
        });
      }
    }

    // If match completed, advance winner in bracket
    if (updates.status === 'completed' && match.next_match_id) {
      const nextMatch = await db(t('matches')).where('id', match.next_match_id).first();
      if (nextMatch) {
        const updateField = nextMatch.participant_1_registration_id
          ? 'participant_2_registration_id'
          : 'participant_1_registration_id';
        await db(t('matches')).where('id', match.next_match_id).update({
          [updateField]: winner_registration_id,
          updated_at: now,
        });
      }
    }

    await AuditService.logFromRequest(req, 'match.result_entered', 'match', matchId, {
      changes: { before, after: updates },
      metadata: { scores, notes },
    });

    res.json({ success: true, data: { message: 'Result saved', match_id: matchId } });
  } catch (error) {
    next(error);
  }
});

// Correct a result (revert winner, reopen match)
router.put('/matches/:matchId/correct', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const matchId = parseInt(req.params.matchId, 10);
    const { reason } = req.body;

    const match = await db(t('matches')).where('id', matchId).first();
    if (!match) throw AppError.notFound('Match');

    const before = {
      status: match.status,
      winner_registration_id: match.winner_registration_id,
    };

    const now = new Date();
    await db(t('matches')).where('id', matchId).update({
      winner_registration_id: null,
      status: 'in_progress',
      completed_at: null,
      updated_at: now,
    });

    // Remove from next match if advanced
    if (match.next_match_id && match.winner_registration_id) {
      await db(t('matches'))
        .where('id', match.next_match_id)
        .where(function () {
          this.where('participant_1_registration_id', match.winner_registration_id)
            .orWhere('participant_2_registration_id', match.winner_registration_id);
        })
        .update({
          participant_1_registration_id: db.raw(
            `CASE WHEN participant_1_registration_id = ${match.winner_registration_id} THEN NULL ELSE participant_1_registration_id END`
          ),
          participant_2_registration_id: db.raw(
            `CASE WHEN participant_2_registration_id = ${match.winner_registration_id} THEN NULL ELSE participant_2_registration_id END`
          ),
          updated_at: now,
        });
    }

    await AuditService.logFromRequest(req, 'match.result_corrected', 'match', matchId, {
      changes: { before, after: { status: 'in_progress', winner_registration_id: null } },
      metadata: { reason },
    });

    res.json({ success: true, data: { message: 'Result corrected', match_id: matchId } });
  } catch (error) {
    next(error);
  }
});

// Set final placements after tournament completion
router.post('/events/:id/placements', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const eventId = parseInt(req.params.id, 10);
    const { placements } = req.body;

    if (!Array.isArray(placements)) throw AppError.badRequest('placements must be an array');

    const event = await db(t('events')).where('id', eventId).first();
    if (!event) throw AppError.notFound('Event');

    await db.transaction(async (trx) => {
      for (const p of placements) {
        await trx(t('registrations'))
          .where('id', p.registration_id)
          .where('event_id', eventId)
          .update({
            final_placement: p.placement,
            prize_amount_cents: p.prize_amount_cents || 0,
            updated_at: new Date(),
          });
      }

      if (event.status !== 'completed') {
        await trx(t('events')).where('id', eventId).update({
          status: 'completed',
          updated_at: new Date(),
        });
      }
    });

    await AuditService.logFromRequest(req, 'event.placements_set', 'event', eventId, {
      resourceLabel: event.title,
      metadata: { placements },
    });

    res.json({ success: true, data: { message: 'Placements recorded' } });
  } catch (error) {
    next(error);
  }
});

// ============================================================
// 6. PUSH NOTIFICATIONS TO PARTICIPANTS
// ============================================================

router.post('/events/:id/notify', validateBody(notifyParticipantsSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const eventId = parseInt(req.params.id, 10);
    const { subject, body, target = 'all_participants' } = req.body;

    if (!subject || !body) throw AppError.badRequest('subject and body are required');

    const event = await db(t('events')).where('id', eventId).first();
    if (!event) throw AppError.notFound('Event');

    let recipientQuery = db(t('registrations'))
      .where('event_id', eventId);

    if (target === 'confirmed_only') {
      recipientQuery = recipientQuery.where('status', 'confirmed');
    } else if (target === 'waitlisted_only') {
      recipientQuery = recipientQuery.where('status', 'waitlisted');
    } else {
      recipientQuery = recipientQuery.whereIn('status', ['confirmed', 'pending_payment', 'waitlisted']);
    }

    const recipients = await recipientQuery.select('user_id');

    const now = new Date();

    if (recipients.length > 0) {
      const notifications = recipients.map((r: any) => ({
        user_id: r.user_id,
        type: 'general' as const,
        title: subject,
        body: body,
        data: JSON.stringify({ event_id: eventId, type: 'admin_message' }),
        created_at: now,
      }));

      await db(t('notifications')).insert(notifications);
    }

    await db(t('admin_messages')).insert({
      event_id: eventId,
      sent_by: req.user!.userId,
      subject,
      body,
      target,
      recipient_count: recipients.length,
      sent_at: now,
      created_at: now,
    });

    await AuditService.logFromRequest(req, 'notification.sent', 'event', eventId, {
      resourceLabel: event.title,
      metadata: { subject, target, recipient_count: recipients.length },
    });

    res.json({
      success: true,
      data: { message: `Notification sent to ${recipients.length} participants`, recipient_count: recipients.length },
    });
  } catch (error) {
    next(error);
  }
});

// Get notification history for event
router.get('/events/:id/messages', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const eventId = parseInt(req.params.id, 10);

    const messages = await db(t('admin_messages'))
      .where('event_id', eventId)
      .leftJoin(t('users'), `${t('admin_messages')}.sent_by`, `${t('users')}.id`)
      .select(
        `${t('admin_messages')}.*`,
        `${t('users')}.email as sender_email`
      )
      .orderBy('sent_at', 'desc');

    res.json({ success: true, data: messages });
  } catch (error) {
    next(error);
  }
});

// ============================================================
// 7. REFUND MANAGEMENT
// ============================================================

// List refunds
router.get('/refunds', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status, page = 1, per_page = 20 } = req.query;

    let query = db(t('refunds'))
      .leftJoin(t('payments'), `${t('refunds')}.payment_id`, `${t('payments')}.id`)
      .leftJoin(t('users'), `${t('refunds')}.requested_by`, `${t('users')}.id`)
      .select(
        `${t('refunds')}.*`,
        `${t('payments')}.stripe_payment_intent_id`,
        `${t('payments')}.net_amount_cents as original_amount`,
        `${t('users')}.email as requester_email`
      );

    if (status) query = query.where(`${t('refunds')}.status`, status as string);

    const countQuery = query.clone();
    const [{ count: total }] = await countQuery.count('* as count');
    const offset = (Number(page) - 1) * Number(per_page);

    const refunds = await query
      .orderBy(`${t('refunds')}.created_at`, 'desc')
      .limit(Number(per_page))
      .offset(offset);

    res.json({
      success: true,
      data: refunds,
      meta: {
        page: Number(page),
        per_page: Number(per_page),
        total: Number(total),
        total_pages: Math.ceil(Number(total) / Number(per_page)),
      },
    });
  } catch (error) {
    next(error);
  }
});

// Approve/process refund
router.put('/refunds/:id/approve', validateBody(refundDecisionSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const refundId = parseInt(req.params.id, 10);
    const refund = await db(t('refunds')).where('id', refundId).first();
    if (!refund) throw AppError.notFound('Refund');

    if (refund.status !== 'pending') {
      throw AppError.badRequest('Only pending refunds can be approved');
    }

    const now = new Date();
    await db(t('refunds')).where('id', refundId).update({
      status: 'approved',
      processed_by: req.user!.userId,
      processed_at: now,
      updated_at: now,
    });

    await AuditService.logFromRequest(req, 'refund.approved', 'refund', refundId, {
      metadata: { amount_cents: refund.amount_cents, payment_id: refund.payment_id },
    });

    res.json({ success: true, data: { message: 'Refund approved', refund_id: refundId } });
  } catch (error) {
    next(error);
  }
});

// Reject refund
router.put('/refunds/:id/reject', validateBody(refundDecisionSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const refundId = parseInt(req.params.id, 10);
    const { reason } = req.body;

    const refund = await db(t('refunds')).where('id', refundId).first();
    if (!refund) throw AppError.notFound('Refund');

    if (refund.status !== 'pending') {
      throw AppError.badRequest('Only pending refunds can be rejected');
    }

    const now = new Date();
    await db(t('refunds')).where('id', refundId).update({
      status: 'rejected',
      processed_by: req.user!.userId,
      reason_detail: reason || refund.reason_detail,
      processed_at: now,
      updated_at: now,
    });

    await AuditService.logFromRequest(req, 'refund.rejected', 'refund', refundId, {
      metadata: { reason, amount_cents: refund.amount_cents },
    });

    res.json({ success: true, data: { message: 'Refund rejected' } });
  } catch (error) {
    next(error);
  }
});

// Create manual refund
router.post('/refunds', validateBody(createRefundSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { payment_id, registration_id, amount_cents, reason, reason_detail } = req.body;

    // Validate the payment is refundable. Without these checks an admin
    // could refund against a pending/failed payment, or refund more than
    // was actually charged. We sum already-issued refunds so the new
    // amount + previous refunds never exceeds net_amount_cents.
    const payment = await db(t('payments')).where('id', payment_id).first();
    if (!payment) throw AppError.notFound('Payment');
    if (payment.status !== 'succeeded' && payment.status !== 'partially_refunded') {
      throw AppError.badRequest('Only succeeded payments can be refunded');
    }

    const [{ total: alreadyRefunded }] = await db(t('refunds'))
      .where('payment_id', payment_id)
      .whereIn('status', ['approved', 'processed'])
      .sum('amount_cents as total');
    const refundedSoFar = Number(alreadyRefunded || 0);
    const remaining = (payment.net_amount_cents || 0) - refundedSoFar;
    if (amount_cents > remaining) {
      throw AppError.badRequest(
        `Refund amount exceeds remaining payment balance (max ${remaining} cents)`
      );
    }

    const now = new Date();
    const [refundId] = await db(t('refunds')).insert({
      uuid: uuidv4(),
      payment_id,
      registration_id: registration_id || null,
      requested_by: req.user!.userId,
      processed_by: req.user!.userId,
      amount_cents,
      currency: payment.currency || 'EUR',
      reason: reason || 'admin_decision',
      reason_detail: reason_detail || null,
      status: 'approved',
      requested_at: now,
      processed_at: now,
      created_at: now,
      updated_at: now,
    });

    await AuditService.logFromRequest(req, 'refund.created_manual', 'refund', refundId, {
      metadata: { payment_id, amount_cents, reason },
    });

    res.status(201).json({ success: true, data: { refund_id: refundId, status: 'approved' } });
  } catch (error) {
    next(error);
  }
});

// ============================================================
// 8. HALL OF FAME MANAGEMENT
// ============================================================

// Add Hall of Fame entry
router.post('/hall-of-fame', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      event_id, user_id, placement, prize_amount_cents = 0,
      display_name, team_name, achievement_note, featured = false,
    } = req.body;

    const event = await db(t('events')).where('id', event_id).first();
    if (!event) throw AppError.notFound('Event');

    const now = new Date();
    const [entryId] = await db(t('hall_of_fame')).insert({
      event_id,
      user_id,
      placement,
      prize_amount_cents,
      display_name: display_name || null,
      team_name: team_name || null,
      achievement_note: achievement_note || null,
      featured,
      created_at: now,
      updated_at: now,
    });

    await AuditService.logFromRequest(req, 'hall_of_fame.created', 'hall_of_fame', entryId, {
      resourceLabel: `${display_name || 'User ' + user_id} - Place ${placement}`,
      metadata: { event_id, user_id, placement },
    });

    res.status(201).json({ success: true, data: { id: entryId } });
  } catch (error) {
    next(error);
  }
});

// Update Hall of Fame entry
router.put('/hall-of-fame/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const entryId = parseInt(req.params.id, 10);
    const entry = await db(t('hall_of_fame')).where('id', entryId).first();
    if (!entry) throw AppError.notFound('Hall of Fame entry');

    const allowedFields = ['placement', 'prize_amount_cents', 'display_name', 'team_name', 'achievement_note', 'featured'];
    const updates: Record<string, any> = {};

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    updates.updated_at = new Date();
    await db(t('hall_of_fame')).where('id', entryId).update(updates);

    await AuditService.logFromRequest(req, 'hall_of_fame.updated', 'hall_of_fame', entryId, {
      changes: { before: entry, after: updates },
    });

    res.json({ success: true, data: { message: 'Updated' } });
  } catch (error) {
    next(error);
  }
});

// Delete Hall of Fame entry
router.delete('/hall-of-fame/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const entryId = parseInt(req.params.id, 10);
    const entry = await db(t('hall_of_fame')).where('id', entryId).first();
    if (!entry) throw AppError.notFound('Hall of Fame entry');

    await db(t('hall_of_fame')).where('id', entryId).del();

    await AuditService.logFromRequest(req, 'hall_of_fame.deleted', 'hall_of_fame', entryId, {
      metadata: { event_id: entry.event_id, user_id: entry.user_id },
    });

    res.json({ success: true, data: { message: 'Deleted' } });
  } catch (error) {
    next(error);
  }
});

// Auto-generate Hall of Fame from tournament results
router.post('/events/:id/generate-hall-of-fame', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const eventId = parseInt(req.params.id, 10);

    const event = await db(t('events')).where('id', eventId).first();
    if (!event) throw AppError.notFound('Event');

    const topPlayers = await db(t('registrations'))
      .where('event_id', eventId)
      .whereNotNull('final_placement')
      .where('final_placement', '<=', 3)
      .leftJoin(t('profiles'), `${t('registrations')}.user_id`, `${t('profiles')}.user_id`)
      .select(
        `${t('registrations')}.user_id`,
        `${t('registrations')}.final_placement`,
        `${t('registrations')}.prize_amount_cents`,
        `${t('profiles')}.first_name`,
        `${t('profiles')}.last_name`,
        `${t('profiles')}.display_name`
      )
      .orderBy('final_placement', 'asc');

    if (topPlayers.length === 0) {
      throw AppError.badRequest('No placements found for this event');
    }

    await db(t('hall_of_fame')).where('event_id', eventId).del();

    const now = new Date();
    const entries = topPlayers.map((p: any) => ({
      event_id: eventId,
      user_id: p.user_id,
      placement: p.final_placement,
      prize_amount_cents: p.prize_amount_cents || 0,
      display_name: p.display_name || `${p.first_name} ${p.last_name}`,
      featured: p.final_placement === 1,
      created_at: now,
      updated_at: now,
    }));

    await db(t('hall_of_fame')).insert(entries);

    await AuditService.logFromRequest(req, 'hall_of_fame.generated', 'event', eventId, {
      resourceLabel: event.title,
      metadata: { entries_created: entries.length },
    });

    res.json({
      success: true,
      data: { message: `Generated ${entries.length} Hall of Fame entries`, count: entries.length },
    });
  } catch (error) {
    next(error);
  }
});

// ============================================================
// 9. AUDIT LOG VIEWER
// ============================================================

router.get('/audit-logs', superadminOnly, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await AuditService.query({
      actor_id: req.query.actor_id ? Number(req.query.actor_id) : undefined,
      action: req.query.action as string,
      resource_type: req.query.resource_type as string,
      resource_id: req.query.resource_id ? Number(req.query.resource_id) : undefined,
      from_date: req.query.from_date as string,
      to_date: req.query.to_date as string,
      page: req.query.page ? Number(req.query.page) : 1,
      per_page: req.query.per_page ? Number(req.query.per_page) : 50,
    });

    res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
});

// Get audit trail for specific resource
router.get('/audit-logs/:type/:id', superadminOnly, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const logs = await AuditService.getResourceHistory(req.params.type, parseInt(req.params.id, 10));
    res.json({ success: true, data: logs });
  } catch (error) {
    next(error);
  }
});

// ============================================================
// 10. USER MANAGEMENT (superadmin only)
// ============================================================

router.get('/users', superadminOnly, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page = 1, per_page = 20, search, role, status } = req.query;
    let query = db(t('users'))
      .leftJoin(t('profiles'), `${t('users')}.id`, `${t('profiles')}.user_id`)
      .leftJoin(t('memberships'), function () {
        this.on(`${t('users')}.id`, '=', `${t('memberships')}.user_id`)
          .andOn(`${t('memberships')}.status`, '=', db.raw("'active'"));
      })
      .select(
        `${t('users')}.id`,
        `${t('users')}.uuid`,
        `${t('users')}.email`,
        `${t('users')}.role`,
        `${t('users')}.status`,
        `${t('users')}.created_at`,
        `${t('profiles')}.first_name`,
        `${t('profiles')}.last_name`,
        `${t('profiles')}.city`,
        `${t('memberships')}.tier as membership_tier`
      );

    if (search) {
      query = query.where(function () {
        this.where(`${t('users')}.email`, 'LIKE', `%${search}%`)
          .orWhere(`${t('profiles')}.first_name`, 'LIKE', `%${search}%`)
          .orWhere(`${t('profiles')}.last_name`, 'LIKE', `%${search}%`);
      });
    }
    if (role) query = query.where(`${t('users')}.role`, role as string);
    if (status) query = query.where(`${t('users')}.status`, status as string);

    const countQuery = query.clone();
    const [{ count: total }] = await countQuery.count('* as count');
    const offset = (Number(page) - 1) * Number(per_page);

    const users = await query
      .orderBy(`${t('users')}.created_at`, 'desc')
      .limit(Number(per_page))
      .offset(offset);

    res.json({
      success: true,
      data: users,
      meta: {
        page: Number(page),
        per_page: Number(per_page),
        total: Number(total),
        total_pages: Math.ceil(Number(total) / Number(per_page)),
      },
    });
  } catch (error) {
    next(error);
  }
});

router.put('/users/:id/role', superadminOnly, validateBody(userRoleSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const { role } = req.body;

    const user = await db(t('users')).where('id', userId).first();
    if (!user) throw AppError.notFound('User');

    const before = { role: user.role };
    await db(t('users')).where('id', userId).update({ role, updated_at: new Date() });

    await AuditService.logFromRequest(req, 'user.role_changed', 'user', userId, {
      resourceLabel: user.email,
      changes: { before, after: { role } },
    });

    res.json({ success: true, data: { message: 'Role updated' } });
  } catch (error) {
    next(error);
  }
});

router.put('/users/:id/status', superadminOnly, validateBody(userStatusSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const { status } = req.body;

    const user = await db(t('users')).where('id', userId).first();
    if (!user) throw AppError.notFound('User');

    const before = { status: user.status };
    await db(t('users')).where('id', userId).update({ status, updated_at: new Date() });

    await AuditService.logFromRequest(req, 'user.status_changed', 'user', userId, {
      resourceLabel: user.email,
      changes: { before, after: { status } },
    });

    res.json({ success: true, data: { message: 'Status updated' } });
  } catch (error) {
    next(error);
  }
});

// ============================================================
// 11. PLAYTOMIC VERIFICATION QUEUE
// ============================================================

const verifyDecisionSchema = z.object({
  level: z.number().min(0).max(7).optional(),
});

router.get('/playtomic/pending', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const pending = await PlaytomicService.listPending();
    res.json({ success: true, data: pending });
  } catch (error) {
    next(error);
  }
});

router.post(
  '/playtomic/:userId/approve',
  validateBody(verifyDecisionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = parseInt(req.params.userId, 10);
      const result = await PlaytomicService.approve(
        userId,
        req.user!.userId,
        req.body.level,
      );
      await AuditService.logFromRequest(req, 'playtomic.approved', 'user', userId, {
        metadata: { applied_elo: result.elo, level: req.body.level },
      });
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/playtomic/:userId/reject',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = parseInt(req.params.userId, 10);
      await PlaytomicService.reject(userId, req.user!.userId);
      await AuditService.logFromRequest(req, 'playtomic.rejected', 'user', userId, {});
      res.json({ success: true, data: { message: 'Rejected' } });
    } catch (error) {
      next(error);
    }
  }
);

// ============================================================
// 12. COURT AVAILABILITY MANAGEMENT
// ============================================================

const availabilitySlotSchema = z.object({
  venue_id: z.number().int().positive(),
  court_id: z.number().int().positive().optional(),
  slot_date: z.string(),
  slot_start: z.string(),
  slot_end: z.string(),
  status: z.enum(['available', 'booked', 'blocked']).optional(),
  price_cents: z.number().int().nonnegative().optional(),
  booking_url: z.string().url().optional(),
});

const recurringSlotSchema = z.object({
  venue_id: z.number().int().positive(),
  court_id: z.number().int().positive().optional(),
  from_date: z.string(),
  to_date: z.string(),
  daily_start: z.string(),
  daily_end: z.string(),
  slot_duration_minutes: z.number().int().min(15).max(240),
  price_cents: z.number().int().nonnegative().optional(),
  booking_url: z.string().url().optional(),
});

router.post(
  '/availability',
  validateBody(availabilitySlotSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = await CourtAvailabilityService.upsertSlot(req.body);
      res.json({ success: true, data: { id } });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/availability/recurring',
  validateBody(recurringSlotSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const count = await CourtAvailabilityService.generateRecurring(req.body);
      res.json({ success: true, data: { created: count } });
    } catch (error) {
      next(error);
    }
  }
);

export { router as adminRouter };