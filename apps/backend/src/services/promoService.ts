import { db, t } from '../config/database';
import { AppError } from '../middleware/errorHandler';

/**
 * PromoService — discount codes for tournament entry fees.
 *
 * A code is either percent-based or fixed-amount; one redemption per
 * user per code; optional global redemption cap and expiry. Validation
 * is read-only — redemption is recorded when the discounted payment is
 * actually created so abandoned checkouts don't burn codes.
 */
export class PromoService {
  static async validate(code: string, userId: number, baseAmountCents: number) {
    const promo = await db(t('promo_codes'))
      .whereRaw('UPPER(code) = ?', [code.toUpperCase().trim()])
      .first();
    if (!promo || !promo.is_active) throw AppError.badRequest('Ungültiger Promo-Code');
    if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
      throw AppError.badRequest('Dieser Promo-Code ist abgelaufen');
    }
    if (promo.max_redemptions !== null && promo.redemption_count >= promo.max_redemptions) {
      throw AppError.badRequest('Dieser Promo-Code ist ausgeschöpft');
    }
    const used = await db(t('promo_redemptions'))
      .where({ promo_code_id: promo.id, user_id: userId })
      .first();
    if (used) throw AppError.badRequest('Du hast diesen Code bereits eingelöst');

    const discount = promo.percent_off
      ? Math.round((baseAmountCents * promo.percent_off) / 100)
      : Math.min(promo.amount_off_cents ?? 0, baseAmountCents);

    return {
      promo_code_id: promo.id as number,
      code: promo.code as string,
      discount_cents: discount,
      final_amount_cents: Math.max(0, baseAmountCents - discount),
    };
  }

  /** Records the redemption — call once the discounted payment exists. */
  static async redeem(promoCodeId: number, userId: number, paymentId: number | null) {
    const now = new Date();
    await db.transaction(async (trx) => {
      const promo = await trx(t('promo_codes')).where('id', promoCodeId).forUpdate().first();
      if (!promo) return;
      if (promo.max_redemptions !== null && promo.redemption_count >= promo.max_redemptions) {
        throw AppError.badRequest('Dieser Promo-Code ist ausgeschöpft');
      }
      await trx(t('promo_redemptions')).insert({
        promo_code_id: promoCodeId,
        user_id: userId,
        payment_id: paymentId,
        created_at: now,
      });
      await trx(t('promo_codes'))
        .where('id', promoCodeId)
        .increment('redemption_count', 1);
    });
  }

  static async createCode(input: {
    code: string;
    percent_off?: number;
    amount_off_cents?: number;
    max_redemptions?: number;
    expires_at?: string;
  }) {
    if (!input.percent_off && !input.amount_off_cents) {
      throw AppError.badRequest('percent_off oder amount_off_cents ist erforderlich');
    }
    const now = new Date();
    const [id] = await db(t('promo_codes')).insert({
      code: input.code.toUpperCase().trim(),
      percent_off: input.percent_off ?? null,
      amount_off_cents: input.amount_off_cents ?? null,
      max_redemptions: input.max_redemptions ?? null,
      expires_at: input.expires_at ? new Date(input.expires_at) : null,
      is_active: true,
      created_at: now,
    });
    return db(t('promo_codes')).where('id', id).first();
  }

  static async list() {
    return db(t('promo_codes')).orderBy('created_at', 'desc').limit(100);
  }

  static async deactivate(id: number) {
    await db(t('promo_codes')).where('id', id).update({ is_active: false });
    return { id, is_active: false };
  }
}
