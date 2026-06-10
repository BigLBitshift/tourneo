import { Router, Request, Response, NextFunction } from 'express';
import { optionalAuth } from '../middleware/auth';
import { leaderboardQuerySchema } from '../validators/bookings';
import { LeaderboardService } from '../services/leaderboardService';

const router = Router();

// City / global leaderboard. Adds the viewer's own rank when logged in.
router.get('/', optionalAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = leaderboardQuerySchema.parse(req.query);
    // 60s cache — ranks only move when matches finish.
    const { withCache } = await import('../utils/cache');
    const board = await withCache(
      `leaderboard:${query.sport}:${query.city || '_global'}:${query.limit}`,
      60,
      () => LeaderboardService.top({ sport: query.sport, city: query.city, limit: query.limit })
    );

    let myRank: number | null = null;
    if (req.user) {
      myRank = await LeaderboardService.rankOf(req.user.userId, query.sport, query.city);
    }

    res.json({ success: true, data: { ...board, my_rank: myRank } });
  } catch (error) {
    next(error);
  }
});

export { router as leaderboardRouter };
