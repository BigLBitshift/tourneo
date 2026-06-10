import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { PlayNowService } from '../services/playNowService';

const router = Router();

const openRequestSchema = z.object({
  sport: z.enum(['padel', 'fifa']).default('padel'),
  city: z.string().max(100).optional(),
  slot_id: z.number().int().positive().optional(),
});

const directChallengeSchema = z.object({
  opponent_user_id: z.number().int().positive(),
  sport: z.enum(['padel', 'fifa']).default('padel'),
  slot_id: z.number().int().positive().optional(),
});

// "Spiel jetzt": find matching players, optionally with a slot attached
router.post(
  '/play-now',
  authenticate,
  validateBody(openRequestSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const request = await PlayNowService.createOpenRequest(req.user!.userId, req.body);
      res.status(201).json({ success: true, data: request });
    } catch (error) {
      next(error);
    }
  }
);

// Direct challenge against a specific player
router.post(
  '/challenges',
  authenticate,
  validateBody(directChallengeSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const request = await PlayNowService.createDirectChallenge(
        req.user!.userId,
        req.body.opponent_user_id,
        req.body
      );
      res.status(201).json({ success: true, data: request });
    } catch (error) {
      next(error);
    }
  }
);

// My open requests + invites awaiting my answer
router.get('/play-now', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const list = await PlayNowService.listForUser(req.user!.userId);
    res.json({ success: true, data: list });
  } catch (error) {
    next(error);
  }
});

router.get('/play-now/:id', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const request = await PlayNowService.getRequest(parseInt(req.params.id, 10));
    res.json({ success: true, data: request });
  } catch (error) {
    next(error);
  }
});

router.post(
  '/play-now/:id/accept',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const request = await PlayNowService.respond(
        parseInt(req.params.id, 10),
        req.user!.userId,
        true
      );
      res.json({ success: true, data: request });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/play-now/:id/decline',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const request = await PlayNowService.respond(
        parseInt(req.params.id, 10),
        req.user!.userId,
        false
      );
      res.json({ success: true, data: request });
    } catch (error) {
      next(error);
    }
  }
);

router.delete(
  '/play-now/:id',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await PlayNowService.cancel(parseInt(req.params.id, 10), req.user!.userId);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

export { router as playNowRouter };
