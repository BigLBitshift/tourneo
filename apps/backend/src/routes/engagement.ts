import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, optionalAuth } from '../middleware/auth';
import { EngagementService } from '../services/engagementService';
import { SeasonService } from '../services/seasonService';
import { db, t } from '../config/database';

const router = Router();

// Weekly challenges with live progress
router.get('/me/challenges', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const challenges = await EngagementService.getWeeklyChallenges(req.user!.userId);
    res.json({ success: true, data: challenges });
  } catch (error) {
    next(error);
  }
});

// Activity feed (friends + city, last 7 days)
router.get('/me/feed', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const feed = await EngagementService.getFeed(req.user!.userId);
    res.json({ success: true, data: feed });
  } catch (error) {
    next(error);
  }
});

// My streak
router.get('/me/streak', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const profile = await db(t('profiles')).where('user_id', req.user!.userId).first();
    res.json({
      success: true,
      data: {
        week_streak: Number(profile?.week_streak ?? 0),
        longest_week_streak: Number(profile?.longest_week_streak ?? 0),
        last_played_week: profile?.last_played_week ?? null,
      },
    });
  } catch (error) {
    next(error);
  }
});

// Current season + my season history
router.get('/seasons/current', optionalAuth, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const season = await SeasonService.getCurrent();
    res.json({ success: true, data: season ?? null });
  } catch (error) {
    next(error);
  }
});

router.get('/me/seasons', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const history = await SeasonService.getUserSeasonHistory(req.user!.userId);
    res.json({ success: true, data: history });
  } catch (error) {
    next(error);
  }
});

// Private-event lookup by invite token (public, the token IS the secret)
router.get('/events/by-invite/:token', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = String(req.params.token).slice(0, 36);
    const event = await db(t('events')).where('invite_token', token).first();
    if (!event) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Invite link is invalid' },
      });
    }
    const { EventService } = await import('../services/eventService');
    const full = await EventService.getEventById(event.id);
    res.json({ success: true, data: { ...full, invite_token: token } });
  } catch (error) {
    next(error);
  }
});

export { router as engagementRouter };
