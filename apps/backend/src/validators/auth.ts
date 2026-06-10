import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().email('Valid email is required').max(255),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128)
    .regex(
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/,
      'Password must contain at least one lowercase letter, one uppercase letter, and one number'
    ),
  first_name: z.string().min(1, 'First name is required').max(100),
  last_name: z.string().min(1, 'Last name is required').max(100),
  display_name: z.string().max(100).optional(),
  date_of_birth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format')
    .refine(
      (dob) => {
        const birthDate = new Date(dob);
        const today = new Date();
        const age = today.getFullYear() - birthDate.getFullYear();
        const monthDiff = today.getMonth() - birthDate.getMonth();
        const dayDiff = today.getDate() - birthDate.getDate();
        const actualAge = monthDiff < 0 || (monthDiff === 0 && dayDiff < 0) ? age - 1 : age;
        return actualAge >= 18;
      },
      { message: 'You must be at least 18 years old' }
    )
    .refine(
      (dob) => {
        const date = new Date(dob);
        return !isNaN(date.getTime()) && date.toISOString().startsWith(dob);
      },
      { message: 'Invalid date' }
    ),
  city: z.string().max(100).optional(),
  region: z.string().max(100).optional(),
  country: z.string().length(2).default('DE'),
  locale: z.string().max(10).default('de'),
  consent_terms: z.literal(true, {
    errorMap: () => ({ message: 'You must accept the Terms of Participation' }),
  }),
  consent_privacy: z.literal(true, {
    errorMap: () => ({ message: 'You must acknowledge the Privacy Policy' }),
  }),
  consent_age: z.literal(true, {
    errorMap: () => ({ message: 'You must confirm you are at least 18 years old' }),
  }),
  consent_media: z.boolean().default(false),
  terms_version_id: z.number().int().positive(),
  privacy_version_id: z.number().int().positive(),
  referral_code: z.string().trim().min(1).max(32).optional(),
});

export const loginSchema = z.object({
  email: z.string().email('Valid email is required'),
  password: z.string().min(1, 'Password is required'),
});

export const appleSignInSchema = z.object({
  identity_token: z.string().min(1, 'Apple identity token is required'),
  // Optional: the mobile client only sends the identity token; the
  // authorization code is only needed for server-to-server token exchange
  // (refresh/revoke), which we don't do yet.
  authorization_code: z.string().min(1).optional(),
  first_name: z.string().max(100).optional(),
  last_name: z.string().max(100).optional(),
  email: z.string().email().optional(),
});

export const refreshTokenSchema = z.object({
  refresh_token: z.string().min(1, 'Refresh token is required'),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email('Valid email is required'),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Reset token is required'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128)
    .regex(
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/,
      'Password must contain at least one lowercase letter, one uppercase letter, and one number'
    ),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type AppleSignInInput = z.infer<typeof appleSignInSchema>;
export type RefreshTokenInput = z.infer<typeof refreshTokenSchema>;