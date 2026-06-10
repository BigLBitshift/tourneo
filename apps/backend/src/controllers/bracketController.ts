import { Request, Response, NextFunction } from 'express';
import { BracketService } from '../services/bracketService';

export class BracketController {
  static async generate(req: Request, res: Response, next: NextFunction) {
    try {
      const eventId = parseInt(req.params.id, 10);
      const bracket = await BracketService.generateBracket(eventId, req.user!.userId);
      res.status(201).json({ success: true, data: bracket });
    } catch (error) {
      next(error);
    }
  }

  static async get(req: Request, res: Response, next: NextFunction) {
    try {
      const eventId = parseInt(req.params.id, 10);
      const bracket = await BracketService.getBracket(eventId);
      res.json({ success: true, data: bracket });
    } catch (error) {
      next(error);
    }
  }

  static async generateRoundRobin(req: Request, res: Response, next: NextFunction) {
    try {
      const eventId = parseInt(req.params.id, 10);
      const bracket = await BracketService.generateRoundRobin(eventId, req.user!.userId);
      res.status(201).json({ success: true, data: bracket });
    } catch (error) {
      next(error);
    }
  }

  static async getStandings(req: Request, res: Response, next: NextFunction) {
    try {
      const eventId = parseInt(req.params.id, 10);
      const standings = await BracketService.getStandings(eventId);
      res.json({ success: true, data: standings });
    } catch (error) {
      next(error);
    }
  }

  static async getMatchCard(req: Request, res: Response, next: NextFunction) {
    try {
      const matchId = parseInt(req.params.matchId, 10);
      const card = await BracketService.getMatchCard(matchId);
      res.json({ success: true, data: card });
    } catch (error) {
      next(error);
    }
  }

  static async enterResult(req: Request, res: Response, next: NextFunction) {
    try {
      const matchId = parseInt(req.params.id, 10);
      const { scores, winner_registration_id } = req.body;
      const bracket = await BracketService.enterMatchResult(
        matchId,
        scores,
        winner_registration_id,
        req.user!.userId
      );
      res.json({ success: true, data: bracket });
    } catch (error) {
      next(error);
    }
  }

  static async enterScores(req: Request, res: Response, next: NextFunction) {
    try {
      const matchId = parseInt(req.params.matchId, 10);
      const { sets } = req.body;
      const result = await BracketService.enterScoresAsPlayer(matchId, sets, req.user!.userId);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  static async getMatchScores(req: Request, res: Response, next: NextFunction) {
    try {
      const matchId = parseInt(req.params.matchId, 10);
      const { db, t } = require('../config/database');
      const match = await db(t('matches')).where('id', matchId).first();
      if (!match) {
        res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Match not found' } });
        return;
      }
      const scores = await db(t('match_scores'))
        .where('match_id', matchId)
        .orderBy('set_number', 'asc');
      res.json({ success: true, data: { match, scores } });
    } catch (error) {
      next(error);
    }
  }

  static async getNextMatch(req: Request, res: Response, next: NextFunction) {
    try {
      const next = await BracketService.getNextMatchForUser(req.user!.userId);
      res.json({ success: true, data: next });
    } catch (error) {
      next(error);
    }
  }

  static async publish(req: Request, res: Response, next: NextFunction) {
    try {
      const { db, t } = require('../config/database');
      const eventId = parseInt(req.params.id, 10);
      const now = new Date();

      await db(t('brackets')).where('event_id', eventId).update({
        status: 'published',
        published_at: now,
        updated_at: now,
      });

      const bracket = await BracketService.getBracket(eventId);
      res.json({ success: true, data: bracket });
    } catch (error) {
      next(error);
    }
  }
}