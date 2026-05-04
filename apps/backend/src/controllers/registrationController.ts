import { Request, Response, NextFunction } from 'express';
import { RegistrationService } from '../services/registrationService';
import { BracketService } from '../services/bracketService';
import { db, t } from '../config/database';

export class RegistrationController {
  static async register(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await RegistrationService.createRegistration(req.body, req.user!.userId);
      res.status(201).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  static async cancel(req: Request, res: Response, next: NextFunction) {
    try {
      const registrationId = parseInt(req.params.id, 10);
      const result = await RegistrationService.cancelRegistration(
        registrationId,
        req.user!.userId,
        req.body.reason
      );
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  static async checkIn(req: Request, res: Response, next: NextFunction) {
    try {
      const registrationId = parseInt(req.params.id, 10);
      const result = await RegistrationService.checkIn(registrationId, req.user!.userId);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  static async listUserRegistrations(req: Request, res: Response, next: NextFunction) {
    try {
      const status = req.query.status as string | undefined;
      const registrations = await RegistrationService.getUserRegistrations(
        req.user!.userId,
        status
      );
      res.json({ success: true, data: registrations });
    } catch (error) {
      next(error);
    }
  }

  static async waitlistStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const registrationId = parseInt(req.params.id, 10);
      const data = await BracketService.getWaitlistStatus(registrationId);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  static async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const registrationId = parseInt(req.params.id, 10);
      const userId = req.user!.userId;
      const isAdmin = req.user!.role === 'admin' || req.user!.role === 'superadmin';

      // Ownership: a registration can be read by the registrant, the partner
      // of a duo registration, or any admin. Anyone else gets a 404 (not 403)
      // so we don't leak existence of registrations belonging to other users.
      let query = db(t('registrations')).where('id', registrationId);
      if (!isAdmin) {
        query = query.andWhere(function () {
          this.where('user_id', userId).orWhere('partner_user_id', userId);
        });
      }
      const registration = await query.first();

      if (!registration) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Registration not found' },
        });
      }

      res.json({ success: true, data: registration });
    } catch (error) {
      next(error);
    }
  }
}