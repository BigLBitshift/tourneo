import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../services/authService';
import { AppleAuthService } from '../services/appleAuthService';

export class AuthController {
  static async register(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await AuthService.register(req.body);
      res.status(201).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  static async appleSignIn(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await AppleAuthService.signIn(req.body);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  static async login(req: Request, res: Response, next: NextFunction) {
    // `bruteForceProtection` attaches these; they are the counters that
    // make the block actually engage. The middleware was fully written and
    // unit-tested but mounted nowhere, so nothing ever counted a failure.
    const trackFailedLogin = (req as any).trackFailedLogin as (() => void) | undefined;
    const resetLoginAttempts = (req as any).resetLoginAttempts as (() => void) | undefined;

    try {
      const result = await AuthService.login(req.body);
      resetLoginAttempts?.();
      res.json({ success: true, data: result });
    } catch (error) {
      trackFailedLogin?.();
      next(error);
    }
  }

  static async refresh(req: Request, res: Response, next: NextFunction) {
    try {
      const { refresh_token } = req.body;
      const tokens = await AuthService.refreshToken(refresh_token);
      res.json({ success: true, data: tokens });
    } catch (error) {
      next(error);
    }
  }

  static async me(req: Request, res: Response, next: NextFunction) {
    try {
      const user = await AuthService.getUserById(req.user!.userId);
      res.json({ success: true, data: user });
    } catch (error) {
      next(error);
    }
  }

  static async logout(_req: Request, res: Response) {
    // In a more complete implementation, we'd invalidate the refresh token
    res.json({ success: true, data: { message: 'Logged out successfully' } });
  }

  static async verifyEmail(req: Request, res: Response, next: NextFunction) {
    try {
      const token = (req.query.token as string) || (req.body?.token as string);
      const result = await AuthService.verifyEmail(token);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  static async resendVerification(req: Request, res: Response, next: NextFunction) {
    try {
      const { email } = req.body;
      const result = await AuthService.resendVerification(email);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  static async forgotPassword(req: Request, res: Response, next: NextFunction) {
    try {
      const { email } = req.body;
      const result = await AuthService.forgotPassword(email);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  static async resetPassword(req: Request, res: Response, next: NextFunction) {
    try {
      const { token, password } = req.body;
      const result = await AuthService.resetPassword(token, password);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
}