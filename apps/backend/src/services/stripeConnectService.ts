import Stripe from 'stripe';
import { db, t } from '../config/database';
import { env } from '../config/environment';
import { AppError } from '../middleware/errorHandler';

const stripe = env.stripe.secretKey
  ? new Stripe(env.stripe.secretKey, { apiVersion: env.stripe.apiVersion as any })
  : null;

/**
 * StripeConnectService — connects venues (clubs) as Stripe Express
 * accounts so in-app court bookings pay out directly to the club while
 * Tourneo keeps a platform fee (destination charges).
 *
 * Flow:
 *   1. Admin calls createOnboardingLink(venueId) → Express account is
 *      created lazily, an account-link URL is returned for the club
 *      owner to complete KYC.
 *   2. Once `charges_enabled` is true, bookings on priced slots create
 *      a PaymentIntent with transfer_data.destination = club account and
 *      application_fee_amount = platform_fee_percent of the price.
 */
export class StripeConnectService {
  static isConfigured(): boolean {
    return stripe !== null;
  }

  static async createOnboardingLink(venueId: number, returnUrl: string, refreshUrl: string) {
    if (!stripe) throw AppError.internal('Payment system not configured');

    const venue = await db(t('venues')).where('id', venueId).first();
    if (!venue) throw AppError.notFound('Venue');

    let accountId: string = venue.stripe_account_id;
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        country: venue.address_country || 'DE',
        business_type: 'company',
        metadata: { venue_id: String(venueId) },
      });
      accountId = account.id;
      await db(t('venues')).where('id', venueId).update({
        stripe_account_id: accountId,
        updated_at: new Date(),
      });
    }

    const link = await stripe.accountLinks.create({
      account: accountId,
      type: 'account_onboarding',
      return_url: returnUrl,
      refresh_url: refreshUrl,
    });

    return { account_id: accountId, onboarding_url: link.url, expires_at: link.expires_at };
  }

  static async getAccountStatus(venueId: number) {
    if (!stripe) throw AppError.internal('Payment system not configured');

    const venue = await db(t('venues')).where('id', venueId).first();
    if (!venue) throw AppError.notFound('Venue');
    if (!venue.stripe_account_id) {
      return { connected: false, charges_enabled: false, payouts_enabled: false };
    }

    const account = await stripe.accounts.retrieve(venue.stripe_account_id);
    return {
      connected: true,
      account_id: venue.stripe_account_id,
      charges_enabled: Boolean(account.charges_enabled),
      payouts_enabled: Boolean(account.payouts_enabled),
      platform_fee_percent: venue.platform_fee_percent ?? 10,
    };
  }

  /**
   * Creates the destination-charge PaymentIntent for a court booking.
   * Returns null when in-app payment isn't possible for this venue
   * (no Stripe key, club not connected) — the caller falls back to
   * pay-at-venue.
   */
  static async createBookingPaymentIntent(params: {
    bookingId: number;
    bookingUuid: string;
    amountCents: number;
    venueStripeAccountId: string | null;
    platformFeePercent: number;
    userId: number;
  }): Promise<{ payment_intent_id: string; client_secret: string } | null> {
    if (!stripe) return null;
    if (!params.venueStripeAccountId) return null;
    if (params.amountCents <= 0) return null;

    const feePercent = Math.min(Math.max(params.platformFeePercent, 0), 50);
    const applicationFee = Math.round((params.amountCents * feePercent) / 100);

    const intent = await stripe.paymentIntents.create({
      amount: params.amountCents,
      currency: 'eur',
      application_fee_amount: applicationFee,
      transfer_data: { destination: params.venueStripeAccountId },
      metadata: {
        booking_id: String(params.bookingId),
        booking_uuid: params.bookingUuid,
        user_id: String(params.userId),
        kind: 'court_booking',
      },
      description: 'Tourneo Platzbuchung',
      statement_descriptor_suffix: 'TOURNEO',
    });

    if (!intent.client_secret) {
      throw AppError.internal('Stripe did not return a client secret');
    }
    return { payment_intent_id: intent.id, client_secret: intent.client_secret };
  }
}
