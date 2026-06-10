import { Request, Response, NextFunction } from 'express';
import Stripe from 'stripe';
import { PaymentService } from '../services/paymentService';
import { env } from '../config/environment';

export class PaymentController {
  static async createIntent(req: Request, res: Response, next: NextFunction) {
    try {
      const { registration_id, promo_code } = req.body;
      const result = await PaymentService.createPaymentIntent(
        registration_id,
        req.user!.userId,
        typeof promo_code === 'string' && promo_code.trim() ? promo_code.trim() : undefined
      );
      res.status(201).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  static async webhook(req: Request, res: Response, next: NextFunction) {
    try {
      const sig = req.headers['stripe-signature'] as string;
      if (!sig || !env.stripe.webhookSecret) {
        return res.status(400).send('Missing signature');
      }

      const stripe = new Stripe(env.stripe.secretKey, { apiVersion: env.stripe.apiVersion as any });
      const event = stripe.webhooks.constructEvent(req.body, sig, env.stripe.webhookSecret);

      await PaymentService.handleStripeWebhook(event);
      res.json({ received: true });
    } catch (error: any) {
      console.error('Webhook error:', error.message);
      res.status(400).send(`Webhook Error: ${error.message}`);
    }
  }

  static async listUserPayments(req: Request, res: Response, next: NextFunction) {
    try {
      const payments = await PaymentService.getUserPayments(req.user!.userId);
      res.json({ success: true, data: payments });
    } catch (error) {
      next(error);
    }
  }

  static async getAdminStats(req: Request, res: Response, next: NextFunction) {
    try {
      const stats = await PaymentService.getAdminPaymentStats();
      res.json({ success: true, data: stats });
    } catch (error) {
      next(error);
    }
  }

  static async processRefund(req: Request, res: Response, next: NextFunction) {
    try {
      const refundId = parseInt(req.params.id, 10);
      const result = await PaymentService.processRefund(refundId, req.user!.userId);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
}