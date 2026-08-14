import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { authenticate, optionalAuth } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { db, t } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { SlotQueueService } from '../services/slotQueueService';

const router = Router();

/**
 * Queue mutations are cheap for us and valuable to the user, but joining
 * and leaving in a loop would let someone probe queue lengths across a
 * whole city. Tighter than the general limiter, looser than payments.
 */
const queueLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Zu viele Anfragen. Bitte kurz warten.' },
  },
});

const joinSchema = z.object({
  auto_claim: z.boolean().optional(),
});

const offerSchema = z.object({
  offer_id: z.number().int().positive().optional(),
});

function slotId(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw AppError.badRequest('Invalid slot id');
  return id;
}

/**
 * Public slot detail.
 *
 * `held_for_user_id` is never exposed — a watcher learns the slot is held
 * and when the hold lapses, never who is holding it.
 */
router.get('/:id', optionalAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = slotId(req);

    const slot = await db(t('court_availability'))
      .leftJoin(t('venues'), `${t('court_availability')}.venue_id`, `${t('venues')}.id`)
      .leftJoin(t('courts'), `${t('court_availability')}.court_id`, `${t('courts')}.id`)
      .where(`${t('court_availability')}.id`, id)
      .select(
        `${t('court_availability')}.id`,
        `${t('court_availability')}.venue_id`,
        `${t('court_availability')}.court_id`,
        `${t('court_availability')}.slot_date`,
        `${t('court_availability')}.slot_start`,
        `${t('court_availability')}.slot_end`,
        `${t('court_availability')}.starts_at_utc`,
        `${t('court_availability')}.ends_at_utc`,
        `${t('court_availability')}.status`,
        `${t('court_availability')}.source`,
        `${t('court_availability')}.confidence`,
        `${t('court_availability')}.price_cents`,
        `${t('court_availability')}.booking_url`,
        `${t('court_availability')}.hold_expires_at`,
        `${t('venues')}.name as venue_name`,
        `${t('venues')}.address_city as venue_city`,
        `${t('courts')}.name as court_name`
      )
      .first();

    if (!slot) throw AppError.notFound('Slot');

    const [queueLength, standing] = await Promise.all([
      SlotQueueService.queueLength(id),
      req.user ? SlotQueueService.standing(id, req.user.userId) : Promise.resolve(null),
    ]);

    res.json({
      success: true,
      data: {
        ...slot,
        queue_length: queueLength,
        hold: slot.status === 'held' ? { expires_at: slot.hold_expires_at } : null,
        my_entry: standing,
        hold_expires_at: undefined,
      },
    });
  } catch (error) {
    next(error);
  }
});

/** Join the queue for a booked slot. */
router.post(
  '/:id/waitlist',
  authenticate,
  queueLimiter,
  validateBody(joinSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const standing = await SlotQueueService.join(slotId(req), req.user!.userId, {
        autoClaim: req.body.auto_claim === true,
      });
      res.status(201).json({ success: true, data: standing });
    } catch (error) {
      next(error);
    }
  }
);

/** Leave the queue. Also passes on a live offer immediately. */
router.delete(
  '/:id/waitlist',
  authenticate,
  queueLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await SlotQueueService.leave(slotId(req), req.user!.userId);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  }
);

/** My standing in one queue. */
router.get(
  '/:id/waitlist/me',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const standing = await SlotQueueService.standing(slotId(req), req.user!.userId);
      if (!standing) throw AppError.notFound('Queue entry');
      res.json({ success: true, data: standing });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Claim a held slot. Returns the same shape as POST /bookings, including
 * `client_secret`, so the mobile checkout path is shared.
 */
router.post(
  '/:id/claim',
  authenticate,
  queueLimiter,
  validateBody(offerSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const booking = await SlotQueueService.claim(
        slotId(req),
        req.user!.userId,
        req.body.offer_id
      );
      res.status(201).json({ success: true, data: booking });
    } catch (error) {
      next(error);
    }
  }
);

/** Pass the offer on. Advances the queue immediately. */
router.post(
  '/:id/decline',
  authenticate,
  queueLimiter,
  validateBody(offerSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await SlotQueueService.decline(slotId(req), req.user!.userId, req.body.offer_id);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  }
);

export { router as slotRouter };
