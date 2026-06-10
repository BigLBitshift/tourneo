import { z } from 'zod';

export const createRegistrationSchema = z.object({
  event_id: z.number().int().positive('Valid event is required'),
  registration_type: z.enum(['solo', 'duo', 'team']),
  team_id: z.number().int().positive().optional(),
  partner_user_id: z.number().int().positive().optional(),
  consent_tournament_terms: z.literal(true, {
    errorMap: () => ({ message: 'You must accept the tournament terms' }),
  }),
  consent_age_verified: z.literal(true, {
    errorMap: () => ({ message: 'You must confirm you are at least 18 years old' }),
  }),
  consent_media: z.boolean().default(false),
  // Required to register for access_type='private' events (shared via link)
  invite_token: z.string().max(36).optional(),
}).refine(
  (data) => {
    if (data.registration_type === 'duo' && !data.partner_user_id) {
      return false;
    }
    return true;
  },
  { message: 'Partner is required for duo registration', path: ['partner_user_id'] }
).refine(
  (data) => {
    if (data.registration_type === 'team' && !data.team_id) {
      return false;
    }
    return true;
  },
  { message: 'Team is required for team registration', path: ['team_id'] }
);

export const cancelRegistrationSchema = z.object({
  reason: z.string().max(500).optional(),
});

export const checkinSchema = z.object({
  latitude: z.number().optional(),
  longitude: z.number().optional(),
});

export const updateRegistrationStatusSchema = z.object({
  status: z.enum(['pending_payment', 'confirmed', 'waitlisted', 'cancelled', 'refunded', 'no_show']),
});

export const setSeedSchema = z.object({
  seed_number: z.number().int().positive(),
});

export type CreateRegistrationInput = z.infer<typeof createRegistrationSchema>;