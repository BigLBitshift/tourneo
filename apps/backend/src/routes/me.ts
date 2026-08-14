import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { promises as fs } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { authenticate } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { ReferralService } from '../services/referralService';
import { AchievementService } from '../services/achievementService';
import { BracketService } from '../services/bracketService';
import { EloService } from '../services/eloService';
import { PlaytomicService } from '../services/playtomicService';
import { MatchFeedbackService } from '../services/matchFeedbackService';
import { RatingHistoryService } from '../services/ratingHistoryService';
import { PlayerDiscoveryService } from '../services/playerDiscoveryService';
import { db, t } from '../config/database';

const router = Router();

// Validation schemas
const declareLevelSchema = z.object({
  level: z.number().min(0).max(7),
});
const submitScreenshotSchema = z.object({
  screenshot_url: z.string().url().max(500),
});
const feedbackSchema = z.object({
  match_id: z.number().int().positive(),
  opponent_user_id: z.number().int().positive(),
  feedback: z.enum(['lower', 'correct', 'higher']),
  comment: z.string().max(500).optional(),
});

// Referral
router.get(
  '/referral',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const stats = await ReferralService.getStats(req.user!.userId);
      res.json({ success: true, data: stats });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/referral/code',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const code = await ReferralService.getOrCreateCode(req.user!.userId);
      res.json({ success: true, data: { code } });
    } catch (error) {
      next(error);
    }
  }
);

// Achievements
router.get(
  '/achievements',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const list = await AchievementService.list(req.user!.userId);
      res.json({ success: true, data: list });
    } catch (error) {
      next(error);
    }
  }
);

// Next match
router.get(
  '/next-match',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const match = await BracketService.getNextMatchForUser(req.user!.userId);
      res.json({ success: true, data: match });
    } catch (error) {
      next(error);
    }
  }
);

// ELO summary (current rating, peak, tier)
router.get(
  '/elo',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const profile = await db(t('profiles'))
        .where('user_id', req.user!.userId)
        .first();
      const padel = Number(profile?.elo_padel ?? 1000);
      const fifa = Number(profile?.elo_fifa ?? 1000);
      res.json({
        success: true,
        data: {
          padel: {
            elo: padel,
            peak: Number(profile?.elo_padel_peak ?? 1000),
            tier: EloService.getTier(padel),
          },
          fifa: {
            elo: fifa,
            peak: Number(profile?.elo_fifa_peak ?? 1000),
            tier: EloService.getTier(fifa),
          },
          matches_played: Number(profile?.elo_matches_played ?? 0),
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ELO history (time series for chart)
router.get(
  '/elo/history',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sport = (req.query.sport as string) === 'fifa' ? 'fifa' : 'padel';
      const limitRaw = Number(req.query.limit);
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 30;
      const history = await RatingHistoryService.listForUser(req.user!.userId, sport, limit);
      res.json({ success: true, data: history });
    } catch (error) {
      next(error);
    }
  },
);

// Discoverable toggle (player search opt-in)
router.put(
  '/discoverable',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const discoverable = Boolean(req.body?.discoverable);
      await db(t('profiles'))
        .where('user_id', req.user!.userId)
        .update({ discoverable, updated_at: new Date() });
      res.json({ success: true, data: { discoverable } });
    } catch (error) {
      next(error);
    }
  },
);

// Bump last_active_at (called on app resume)
router.post(
  '/heartbeat',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await PlayerDiscoveryService.bumpLastActive(req.user!.userId);
      res.json({ success: true, data: { ok: true } });
    } catch (error) {
      next(error);
    }
  },
);

// ──────────────────────────────────────────
// Playtomic: self-declare level
// ──────────────────────────────────────────
router.get(
  '/playtomic',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const status = await PlaytomicService.getStatus(req.user!.userId);
      res.json({ success: true, data: status });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/playtomic/declare',
  authenticate,
  validateBody(declareLevelSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await PlaytomicService.declareLevel(
        req.user!.userId,
        req.body.level,
      );
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/playtomic/screenshot',
  authenticate,
  validateBody(submitScreenshotSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await PlaytomicService.submitScreenshot(
        req.user!.userId,
        req.body.screenshot_url,
      );
      res.json({ success: true, data: { message: 'Screenshot submitted for review' } });
    } catch (error) {
      next(error);
    }
  }
);

// Direct upload (multipart) for Playtomic screenshots
const screenshotUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB max
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png|webp)$/i.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPEG, PNG, or WebP images are accepted'));
  },
});

router.post(
  '/playtomic/upload',
  authenticate,
  screenshotUpload.single('image'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) throw new Error('No file uploaded');

      const uploadsDir = path.join(process.cwd(), 'uploads', 'playtomic');
      await fs.mkdir(uploadsDir, { recursive: true });

      const ext = req.file.mimetype === 'image/png' ? 'png' : req.file.mimetype === 'image/webp' ? 'webp' : 'jpg';
      const filename = `${req.user!.userId}_${uuidv4()}.${ext}`;
      const filepath = path.join(uploadsDir, filename);

      await fs.writeFile(filepath, req.file.buffer);

      const baseUrl = process.env.PUBLIC_BASE_URL || '';
      const url = `${baseUrl}/uploads/playtomic/${filename}`;

      await PlaytomicService.submitScreenshot(req.user!.userId, url);

      res.json({ success: true, data: { url, message: 'Screenshot uploaded' } });
    } catch (error) {
      next(error);
    }
  }
);

// ──────────────────────────────────────────
// Match feedback (rating calibration)
// ──────────────────────────────────────────
router.get(
  '/feedback/pending',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const matches = await MatchFeedbackService.listPending(req.user!.userId);
      res.json({ success: true, data: matches });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/feedback',
  authenticate,
  validateBody(feedbackSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await MatchFeedbackService.submit(
        req.body.match_id,
        req.user!.userId,
        req.body.opponent_user_id,
        req.body.feedback,
        req.body.comment,
      );
      res.json({ success: true, data: { message: 'Feedback recorded' } });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Everything the user is waiting for, split into passive queue entries and
 * live offers with a countdown. Drives the "In der Warteschlange" section
 * on the bookings screen and the cold-start recovery when a push arrives
 * while the app is dead.
 */
router.get('/waitlist', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { SlotQueueService } = await import('../services/slotQueueService');
    res.json({ success: true, data: await SlotQueueService.myQueue(req.user!.userId) });
  } catch (error) {
    next(error);
  }
});

export { router as meRouter };
