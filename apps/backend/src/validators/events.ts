import { z } from 'zod';

const eventBaseFields = {
  title: z.string().min(3, 'Title must be at least 3 characters').max(255),
  description: z.string().max(10000).optional(),
  sport_category: z.enum(['padel', 'fifa', 'other']).default('padel'),
  event_type: z.enum(['tournament', 'open_play', 'special']).default('tournament'),
  venue_id: z.number().int().positive('Valid venue is required'),
  start_date: z.string().datetime('Valid start date is required'),
  end_date: z.string().datetime('Valid end date is required'),
  registration_opens_at: z.string().datetime('Valid registration open date is required'),
  registration_closes_at: z.string().datetime('Valid registration close date is required'),
  is_indoor: z.boolean().default(false),
  is_outdoor: z.boolean().default(false),
  format: z.enum(['singles', 'doubles']).default('doubles'),
  elimination_type: z.enum(['single_elimination', 'double_elimination', 'round_robin']).default('single_elimination'),
  has_third_place_match: z.boolean().default(true),
  max_participants: z.number().int().min(4).max(1024),
  entry_fee_cents: z.number().int().min(0),
  currency: z.string().length(3).default('EUR'),
  total_prize_pool_cents: z.number().int().min(0).default(0),
  level: z.enum(['beginner', 'intermediate', 'advanced', 'open']).default('open'),
  access_type: z.enum(['public', 'members_only', 'club_only']).default('public'),
  has_food_drinks: z.boolean().default(false),
  has_streaming: z.boolean().default(false),
  special_notes: z.string().max(5000).optional(),
  rules_summary: z.string().max(10000).optional(),
  banner_image_url: z.string().url().max(500).optional(),
  sponsor_name: z.string().max(100).optional(),
  sponsor_logo_url: z.string().url().max(500).optional(),
  sponsor_website_url: z.string().url().max(500).optional(),
  prize_distribution: z.array(
    z.object({
      place: z.number().int().positive(),
      amount_cents: z.number().int().min(0),
      label: z.string().max(50).optional(),
    })
  ).optional(),
};

const eventBaseSchema = z.object(eventBaseFields);

export const createEventSchema = eventBaseSchema.refine(
  (data) => new Date(data.end_date) > new Date(data.start_date),
  { message: 'End date must be after start date', path: ['end_date'] }
).refine(
  (data) => new Date(data.registration_closes_at) <= new Date(data.start_date),
  { message: 'Registration must close before or at event start', path: ['registration_closes_at'] }
).refine(
  (data) => new Date(data.registration_opens_at) < new Date(data.registration_closes_at),
  { message: 'Registration must open before it closes', path: ['registration_opens_at'] }
);

export const updateEventSchema = eventBaseSchema.partial().extend({
  status: z.enum(['draft', 'published', 'registration_open', 'registration_closed', 'in_progress', 'completed', 'cancelled']).optional(),
});

export const eventFiltersSchema = z.object({
  sport_category: z.enum(['padel', 'fifa', 'other']).optional(),
  city: z.string().max(100).optional(),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  is_indoor: z.coerce.boolean().optional(),
  is_outdoor: z.coerce.boolean().optional(),
  min_fee: z.coerce.number().min(0).optional(),
  max_fee: z.coerce.number().min(0).optional(),
  level: z.enum(['beginner', 'intermediate', 'advanced', 'open']).optional(),
  status: z.enum(['draft', 'published', 'registration_open', 'registration_closed', 'in_progress', 'completed', 'cancelled']).optional(),
  access_type: z.enum(['public', 'members_only', 'club_only']).optional(),
  has_availability: z.coerce.boolean().optional(),
  page: z.coerce.number().int().positive().default(1),
  per_page: z.coerce.number().int().min(1).max(50).default(20),
  sort_by: z.enum(['date', 'price', 'prize', 'created']).default('date'),
  sort_order: z.enum(['asc', 'desc']).default('asc'),
});

export type CreateEventInput = z.infer<typeof createEventSchema>;
export type UpdateEventInput = z.infer<typeof updateEventSchema>;
export type EventFiltersInput = z.infer<typeof eventFiltersSchema>;