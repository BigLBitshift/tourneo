import { Request, Response, NextFunction } from 'express';
import { EventService } from '../services/eventService';
import { RecapService } from '../services/recapService';
import { IcalService } from '../services/icalService';
import { eventFiltersSchema } from '../validators/events';
import { db, t } from '../config/database';
import { AppError } from '../middleware/errorHandler';

export class EventController {
  static async create(req: Request, res: Response, next: NextFunction) {
    try {
      const event = await EventService.createEvent(req.body, req.user!.userId);
      res.status(201).json({ success: true, data: event });
    } catch (error) {
      next(error);
    }
  }

  static async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const eventId = parseInt(req.params.id, 10);
      const event = await EventService.getEventById(eventId);
      res.json({ success: true, data: event });
    } catch (error) {
      next(error);
    }
  }

  static async list(req: Request, res: Response, next: NextFunction) {
    try {
      const filters = eventFiltersSchema.parse(req.query);
      // 30s read-through cache keyed by the full filter set — the event
      // list is the hottest endpoint and tolerates slightly stale counts.
      const { withCache } = await import('../utils/cache');
      const cacheKey = `events:${JSON.stringify(filters)}`;
      const result = await withCache(cacheKey, 30, () => EventService.listEvents(filters));
      res.json({ success: true, ...result });
    } catch (error) {
      next(error);
    }
  }

  static async publish(req: Request, res: Response, next: NextFunction) {
    try {
      const eventId = parseInt(req.params.id, 10);
      const event = await EventService.publishEvent(eventId, req.user!.userId);
      res.json({ success: true, data: event });
    } catch (error) {
      next(error);
    }
  }

  static async cancel(req: Request, res: Response, next: NextFunction) {
    try {
      const eventId = parseInt(req.params.id, 10);
      const event = await EventService.cancelEvent(eventId, req.user!.userId);
      res.json({ success: true, data: event });
    } catch (error) {
      next(error);
    }
  }

  static async getRecap(req: Request, res: Response, next: NextFunction) {
    try {
      const eventId = parseInt(req.params.id, 10);
      const data = await RecapService.getRecap(eventId);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  static async getIcal(req: Request, res: Response, next: NextFunction) {
    try {
      const eventId = parseInt(req.params.id, 10);
      const ics = await IcalService.generateForEvent(eventId);
      res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="event-${eventId}.ics"`);
      res.send(ics);
    } catch (error) {
      next(error);
    }
  }

  static async update(req: Request, res: Response, next: NextFunction) {
    try {
      const eventId = parseInt(req.params.id, 10);
      const userId = req.user!.userId;
      const isSuperadmin = req.user!.role === 'superadmin';

      // Ownership: the event creator can edit their own event; superadmins
      // can edit any event. The route is already gated by adminOnly so a
      // regular user never reaches here. We do the check + the update inside
      // a single transaction with a row lock so two concurrent edits cannot
      // overwrite each other (last-writer-wins becomes serialised).
      const updated = await db.transaction(async (trx) => {
        const event = await trx(t('events')).where('id', eventId).forUpdate().first();
        if (!event) throw AppError.notFound('Event');

        if (!isSuperadmin && event.created_by !== userId) {
          throw AppError.forbidden('You can only edit events you created');
        }

        // updateEventSchema (Zod) already strips unknown keys; we explicitly
        // drop fields the caller must never set directly. created_by stays
        // immutable so the ownership check above can't be bypassed.
        const { created_by: _ignored, id: _ignoredId, uuid: _ignoredUuid, ...patch } = req.body || {};
        await trx(t('events')).where('id', eventId).update({
          ...patch,
          updated_at: new Date(),
        });
        return true;
      });

      if (!updated) return; // unreachable, throws above
      const event = await EventService.getEventById(eventId);
      res.json({ success: true, data: event });
    } catch (error) {
      next(error);
    }
  }
}