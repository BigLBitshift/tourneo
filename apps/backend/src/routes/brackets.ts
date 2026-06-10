import { Router } from 'express';
import { BracketController } from '../controllers/bracketController';
import { authenticate, adminOnly, optionalAuth } from '../middleware/auth';

const router = Router();

// Public
router.get('/events/:id/bracket', authenticate, BracketController.get);
router.get('/events/:id/standings', optionalAuth, BracketController.getStandings);

// Share-ready match card (players, score, sponsor, ELO delta)
router.get('/:matchId/card', optionalAuth, BracketController.getMatchCard);

// Player-facing match score entry (live scoring / referee mode)
router.post('/:matchId/score', authenticate, BracketController.enterScores);
router.get('/:matchId/score', authenticate, BracketController.getMatchScores);

// Next-match lookup for the home screen alert banner
router.get('/me/next', authenticate, BracketController.getNextMatch);

// Admin
router.post('/events/:id/bracket/generate', authenticate, adminOnly, BracketController.generate);
router.post(
  '/events/:id/bracket/round-robin',
  authenticate,
  adminOnly,
  BracketController.generateRoundRobin
);
router.put('/events/:id/bracket/publish', authenticate, adminOnly, BracketController.publish);
router.put('/:id/result', authenticate, adminOnly, BracketController.enterResult);

export { router as bracketRouter };
