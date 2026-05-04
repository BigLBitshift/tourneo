import { db, t } from '../config/database';
import { AppError } from '../middleware/errorHandler';

export interface VenueReviewRow {
  id: number;
  venue_id: number;
  user_id: number;
  rating: number;
  comment: string | null;
  created_at: Date;
  updated_at: Date;
  display_name?: string | null;
  avatar_url?: string | null;
}

export interface VenuePhotoRow {
  id: number;
  venue_id: number;
  user_id: number;
  image_url: string;
  created_at: Date;
}

export interface VenueRatingSummary {
  average: number;
  count: number;
}

/**
 * VenueReviewService — user reviews and photo uploads for venues.
 */
export class VenueReviewService {
  /**
   * List reviews for a venue, joined with profile info, newest first.
   */
  static async listReviews(venueId: number): Promise<VenueReviewRow[]> {
    return db(t('venue_reviews') + ' as r')
      .leftJoin(t('profiles') + ' as p', 'r.user_id', 'p.user_id')
      .where('r.venue_id', venueId)
      .orderBy('r.created_at', 'desc')
      .select(
        'r.id',
        'r.venue_id',
        'r.user_id',
        'r.rating',
        'r.comment',
        'r.created_at',
        'r.updated_at',
        'p.display_name',
        'p.avatar_url',
        'p.first_name',
        'p.last_name',
      );
  }

  /**
   * Create or update the current user's review for a venue.
   *
   * Two browser tabs submitting the first review for the same venue used
   * to race: both `SELECT` returned no row, both `INSERT` ran, and the
   * UNIQUE(venue_id, user_id) constraint blew up the second one with a
   * duplicate-key error. We now do the read + write inside a single
   * transaction with a row lock on the existing review (if any) so the
   * second writer falls into the UPDATE branch instead.
   */
  static async upsertReview(
    venueId: number,
    userId: number,
    rating: number,
    comment?: string
  ): Promise<VenueReviewRow> {
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw AppError.badRequest('Rating must be an integer between 1 and 5');
    }
    const venue = await db(t('venues')).where('id', venueId).first();
    if (!venue) throw AppError.notFound('Venue');

    const now = new Date();
    const id = await db.transaction(async (trx) => {
      const existing = await trx(t('venue_reviews'))
        .where({ venue_id: venueId, user_id: userId })
        .forUpdate()
        .first();

      if (existing) {
        await trx(t('venue_reviews'))
          .where('id', existing.id)
          .update({ rating, comment: comment ?? null, updated_at: now });
        return existing.id as number;
      }

      try {
        const inserted = await trx(t('venue_reviews')).insert({
          venue_id: venueId,
          user_id: userId,
          rating,
          comment: comment ?? null,
          created_at: now,
          updated_at: now,
        });
        return inserted[0] as number;
      } catch (err: any) {
        // A concurrent first-write that won the race left a row behind
        // between our SELECT and INSERT — recover by updating it.
        if (err?.code === 'ER_DUP_ENTRY' || err?.errno === 1062) {
          const winner = await trx(t('venue_reviews'))
            .where({ venue_id: venueId, user_id: userId })
            .first();
          if (winner) {
            await trx(t('venue_reviews'))
              .where('id', winner.id)
              .update({ rating, comment: comment ?? null, updated_at: now });
            return winner.id as number;
          }
        }
        throw err;
      }
    });

    const row = await db(t('venue_reviews')).where('id', id).first();
    return row as VenueReviewRow;
  }

  /**
   * Returns the average rating and review count for a venue.
   */
  static async getRatingSummary(venueId: number): Promise<VenueRatingSummary> {
    const result = await db(t('venue_reviews'))
      .where('venue_id', venueId)
      .avg('rating as average')
      .count('id as count')
      .first();
    return {
      average: result?.average ? Number(result.average) : 0,
      count: result?.count ? Number(result.count) : 0,
    };
  }

  /**
   * Add a photo URL to a venue (called after multer + sharp processing).
   */
  static async addPhoto(venueId: number, userId: number, imageUrl: string): Promise<VenuePhotoRow> {
    const venue = await db(t('venues')).where('id', venueId).first();
    if (!venue) throw AppError.notFound('Venue');

    const now = new Date();
    const [id] = await db(t('venue_photos')).insert({
      venue_id: venueId,
      user_id: userId,
      image_url: imageUrl,
      created_at: now,
    });

    const row = await db(t('venue_photos')).where('id', id).first();
    return row as VenuePhotoRow;
  }

  /**
   * List photos for a venue, newest first.
   */
  static async listPhotos(venueId: number): Promise<VenuePhotoRow[]> {
    return db(t('venue_photos'))
      .where('venue_id', venueId)
      .orderBy('created_at', 'desc');
  }
}
