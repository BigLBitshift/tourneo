import { Router } from 'express';
import { z } from 'zod';
import { AuthController } from '../controllers/authController';
import { authenticate } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { authLimiter } from '../middleware/rateLimiter';
import {
  registerSchema,
  loginSchema,
  refreshTokenSchema,
  appleSignInSchema,
} from '../validators/auth';

const router = Router();

const emailOnlySchema = z.object({
  email: z.string().email(),
});

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
});

router.post('/register', authLimiter, validateBody(registerSchema), AuthController.register);
router.post('/login', authLimiter, validateBody(loginSchema), AuthController.login);
router.post('/apple', authLimiter, validateBody(appleSignInSchema), AuthController.appleSignIn);
router.post('/refresh', authLimiter, validateBody(refreshTokenSchema), AuthController.refresh);
router.post('/logout', authenticate, AuthController.logout);
router.get('/me', authenticate, AuthController.me);

// Email verification + password reset
router.get('/verify-email', AuthController.verifyEmail);
router.post('/verify-email', AuthController.verifyEmail);
router.post(
  '/resend-verification',
  authLimiter,
  validateBody(emailOnlySchema),
  AuthController.resendVerification
);
router.post(
  '/forgot-password',
  authLimiter,
  validateBody(emailOnlySchema),
  AuthController.forgotPassword
);
router.post(
  '/reset-password',
  authLimiter,
  validateBody(resetPasswordSchema),
  AuthController.resetPassword
);

export { router as authRouter };