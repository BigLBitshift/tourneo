import { z } from 'zod';

export const createBookingSchema = z.object({
  slot_id: z.number().int().positive('Valid slot is required'),
  notes: z.string().max(500).optional(),
});

export const americanoCreateSchema = z.object({
  rounds_count: z.number().int().min(1).max(20).optional(),
  courts_count: z.number().int().min(1).max(20).optional(),
  points_per_match: z.number().int().min(4).max(64).optional(),
});

export const americanoScoreSchema = z.object({
  score_a: z.number().int().min(0).max(64),
  score_b: z.number().int().min(0).max(64),
});

export const leaderboardQuerySchema = z.object({
  sport: z.enum(['padel', 'fifa']).default('padel'),
  city: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type CreateBookingInput = z.infer<typeof createBookingSchema>;
export type AmericanoCreateInput = z.infer<typeof americanoCreateSchema>;
export type AmericanoScoreInput = z.infer<typeof americanoScoreSchema>;
