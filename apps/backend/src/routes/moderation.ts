import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { authenticate, adminOnly } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { AppError } from '../middleware/errorHandler';
import { ModerationService } from '../services/moderationService';

const router = Router();

/**
 * Reporting must stay easy for a genuine user and unattractive for someone
 * trying to bury an account under a pile of reports.
 */
const reportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Zu viele Meldungen. Bitte später erneut.' },
  },
});

const reportSchema = z.object({
  content_type: z.enum(['chat_message', 'venue_review', 'venue_photo', 'profile', 'feed_item']),
  content_id: z.number().int().positive(),
  reason: z.enum(['spam', 'harassment', 'hate_speech', 'sexual', 'violence', 'other']),
  details: z.string().max(1000).optional(),
});

const resolveSchema = z.object({
  action: z.enum(['remove', 'dismiss', 'reviewing']),
  note: z.string().max(1000).optional(),
});

function userIdParam(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw AppError.badRequest('Invalid user id');
  return id;
}

/* ── reporting ───────────────────────────────────────────────── */

router.post(
  '/reports',
  authenticate,
  reportLimiter,
  validateBody(reportSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await ModerationService.report({
        reporterUserId: req.user!.userId,
        contentType: req.body.content_type,
        contentId: req.body.content_id,
        reason: req.body.reason,
        details: req.body.details,
      });
      res.status(201).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

/* ── blocking ────────────────────────────────────────────────── */

router.post(
  '/users/:id/block',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await ModerationService.block(req.user!.userId, userIdParam(req));
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  }
);

router.delete(
  '/users/:id/block',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await ModerationService.unblock(req.user!.userId, userIdParam(req));
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  }
);

router.get('/me/blocks', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: await ModerationService.listBlocked(req.user!.userId) });
  } catch (error) {
    next(error);
  }
});

/* ── moderation queue ────────────────────────────────────────── */

router.get(
  '/admin/reports',
  authenticate,
  adminOnly,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const reports = await ModerationService.listReports({
        status: typeof req.query.status === 'string' ? req.query.status : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      res.json({
        success: true,
        data: reports,
        meta: {
          sla_hours: ModerationService.REVIEW_SLA_HOURS,
          breaching: reports.filter((r: any) => r.breaches_sla).length,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/admin/reports/:id/resolve',
  authenticate,
  adminOnly,
  validateBody(resolveSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const reportId = Number(req.params.id);
      if (!Number.isInteger(reportId) || reportId <= 0) {
        throw AppError.badRequest('Invalid report id');
      }
      const result = await ModerationService.resolveReport(reportId, req.user!.userId, {
        action: req.body.action,
        note: req.body.note,
      });
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

export { router as moderationRouter };
