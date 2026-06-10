import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, adminOnly, optionalAuth } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { americanoCreateSchema, americanoScoreSchema } from '../validators/bookings';
import { AmericanoService } from '../services/americanoService';

const router = Router();

// Create / regenerate the Americano session for an event (admin)
router.post(
  '/events/:id/americano',
  authenticate,
  adminOnly,
  validateBody(americanoCreateSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const eventId = parseInt(req.params.id, 10);
      const session = await AmericanoService.createSession(eventId, req.body, req.user!.userId);
      res.status(201).json({ success: true, data: session });
    } catch (error) {
      next(error);
    }
  }
);

// Full session with all rounds + matches
router.get(
  '/events/:id/americano',
  optionalAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const eventId = parseInt(req.params.id, 10);
      const session = await AmericanoService.getSessionByEvent(eventId);
      res.json({ success: true, data: session });
    } catch (error) {
      next(error);
    }
  }
);

// Individual standings
router.get(
  '/events/:id/americano/standings',
  optionalAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const eventId = parseInt(req.params.id, 10);
      const standings = await AmericanoService.getStandings(eventId);
      res.json({ success: true, data: standings });
    } catch (error) {
      next(error);
    }
  }
);

// Score entry (participants of the match or admins)
router.post(
  '/americano/matches/:id/score',
  authenticate,
  validateBody(americanoScoreSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const matchId = parseInt(req.params.id, 10);
      const result = await AmericanoService.enterScore(
        matchId,
        req.body.score_a,
        req.body.score_b,
        req.user!.userId
      );
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

export { router as americanoRouter };
