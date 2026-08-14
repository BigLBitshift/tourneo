import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import { AuditService } from '../services/auditService';
import { db, t } from '../config/database';
import { env } from '../config/environment';
import { AppError } from '../middleware/errorHandler';

const membershipRouter = Router();

// ============================================================
// TIER DEFINITIONS (static config)
// ============================================================

const TIER_CONFIG = {
  free: {
    id: 'free',
    name: 'Free',
    price_cents: 0,
    currency: 'EUR',
    period: 'month',
    features: [
      'public_tournaments',
      'court_discovery',
      'standard_notifications',
      'basic_profile',
      'team_features',
      'community_basics',
    ],
    feature_labels: {
      public_tournaments: 'Öffentliche Turniere',
      court_discovery: 'Platzsuche',
      standard_notifications: 'Standard-Benachrichtigungen',
      basic_profile: 'Basis-Profil',
      team_features: 'Team-Funktionen',
      community_basics: 'Community-Grundlagen',
    },
    discount_percent: 0,
    early_access_hours: 0,
    waitlist_priority: 'standard',
    max_teams: 1,
  },
  plus: {
    id: 'plus',
    name: 'Tourneo Plus',
    price_cents: 799,
    currency: 'EUR',
    period: 'month',
    apple_product_id: 'com.tourneo.membership.plus.monthly',
    features: [
      'all_free_features',
      'tournament_discount_10',
      'early_access_24h',
      'higher_waitlist_priority',
      'earlier_notifications',
      'exclusive_plus_offers',
      'enhanced_profile',
    ],
    feature_labels: {
      all_free_features: 'Alle Free-Features',
      tournament_discount_10: '10% Rabatt auf Turniergebühren',
      early_access_24h: '24h Early Access',
      higher_waitlist_priority: 'Höhere Wartelisten-Priorität',
      earlier_notifications: 'Frühere Benachrichtigungen',
      exclusive_plus_offers: 'Exklusive Plus-Angebote',
      enhanced_profile: 'Erweitertes Profil',
    },
    discount_percent: 10,
    early_access_hours: 24,
    waitlist_priority: 'high',
    max_teams: 3,
  },
  club: {
    id: 'club',
    name: 'Tourneo Club',
    price_cents: 1499,
    currency: 'EUR',
    period: 'month',
    apple_product_id: 'com.tourneo.membership.club.monthly',
    features: [
      'all_plus_features',
      'tournament_discount_20',
      'early_access_48h',
      'highest_waitlist_priority',
      'exclusive_club_tournaments',
      'high_prize_tournaments',
      'premium_statistics',
      'special_community_benefits',
    ],
    feature_labels: {
      all_plus_features: 'Alle Plus-Features',
      tournament_discount_20: '20% Rabatt auf Turniergebühren',
      early_access_48h: '48h Early Access',
      highest_waitlist_priority: 'Höchste Wartelisten-Priorität',
      exclusive_club_tournaments: 'Exklusive Club-Turniere',
      high_prize_tournaments: 'High-Prize-Turniere',
      premium_statistics: 'Premium-Statistiken',
      special_community_benefits: 'Spezielle Community-Vorteile',
    },
    discount_percent: 20,
    early_access_hours: 48,
    waitlist_priority: 'highest',
    max_teams: 10,
  },
} as const;

// ============================================================
// 1. GET CURRENT MEMBERSHIP (full details)
// ============================================================

membershipRouter.get('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;

    const membership = await db(t('memberships'))
      .where('user_id', userId)
      .where('status', 'active')
      .first();

    const tier = (membership?.tier || 'free') as keyof typeof TIER_CONFIG;
    const tierConfig = TIER_CONFIG[tier];

    // Get stats
    const [{ count: totalEvents }] = await db(t('registrations'))
      .where('user_id', userId)
      .whereIn('status', ['confirmed', 'pending_payment'])
      .count('* as count');

    const [{ total: totalSaved }] = await db(t('registrations'))
      .where('user_id', userId)
      .where('discount_applied_cents', '>', 0)
      .select(db.raw('COALESCE(SUM(discount_applied_cents), 0) as total'));

    // Calculate renewal
    let renewalInfo = null;
    if (membership && membership.tier !== 'free') {
      const expiresAt = membership.expires_at ? new Date(membership.expires_at) : null;
      const daysUntilRenewal = expiresAt
        ? Math.ceil((expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
        : null;

      renewalInfo = {
        expires_at: expiresAt,
        days_until_renewal: daysUntilRenewal,
        auto_renew: membership.status === 'active' && !membership.cancelled_at,
        apple_subscription_id: membership.apple_subscription_id,
      };
    }

    res.json({
      success: true,
      data: {
        current_tier: tier,
        tier_name: tierConfig.name,
        status: membership?.status || 'active',
        price_cents: tierConfig.price_cents,
        currency: tierConfig.currency,
        period: tierConfig.period,
        features: tierConfig.features,
        feature_labels: tierConfig.feature_labels,
        discount_percent: tierConfig.discount_percent,
        early_access_hours: tierConfig.early_access_hours,
        waitlist_priority: tierConfig.waitlist_priority,
        started_at: membership?.started_at || null,
        renewal: renewalInfo,
        stats: {
          total_events_registered: Number(totalEvents),
          total_discount_saved_cents: Number(totalSaved),
        },
        membership_id: membership?.id || null,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ============================================================
// 2. GET ALL TIERS (for comparison/upgrade)
// ============================================================

membershipRouter.get('/tiers', async (_req: Request, res: Response) => {
  const tiers = Object.values(TIER_CONFIG).map((tier) => ({
    ...tier,
    feature_labels: tier.feature_labels,
  }));

  res.json({ success: true, data: { tiers } });
});

// ============================================================
/**
 * Blocks every purchase path while version 1 ships without payments.
 *
 * The tier list and the entitlement checks stay reachable — a free user's
 * membership is a real, queryable thing and the app still needs to render
 * it — but nothing that would grant a paid tier can be reached. Before
 * this, `subscribe` wrote a paid membership on an unverified receipt, so
 * any authenticated user could hand themselves Club for nothing.
 */
function paymentsRequired(_req: Request, res: Response, next: NextFunction): void {
  if (env.features.payments) return next();
  res.status(503).json({
    success: false,
    error: {
      code: 'PAYMENTS_UNAVAILABLE',
      message: 'Mitgliedschaften sind in dieser Version noch nicht verfügbar.',
    },
  });
}

// 3. SUBSCRIBE / UPGRADE / DOWNGRADE
// ============================================================

membershipRouter.post('/subscribe', authenticate, paymentsRequired, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const { receipt_data, product_id } = req.body;
    const now = new Date();

    // Determine target tier from product_id
    let targetTier: 'plus' | 'club' = 'plus';
    if (product_id?.includes('club')) {
      targetTier = 'club';
    }

    const tierConfig = TIER_CONFIG[targetTier];

    // Get current membership
    const existing = await db(t('memberships'))
      .where('user_id', userId)
      .where('status', 'active')
      .first();

    const previousTier = existing?.tier || 'free';

    // Determine if upgrade or downgrade
    const tierRank = { free: 0, plus: 1, club: 2 };
    const isUpgrade = tierRank[targetTier] > tierRank[previousTier as keyof typeof tierRank];
    const isDowngrade = tierRank[targetTier] < tierRank[previousTier as keyof typeof tierRank];

    // In production: verify receipt with Apple's App Store Server API
    // const verifiedReceipt = await AppleReceiptVerifier.verify(receipt_data);

    if (existing && existing.tier !== 'free') {
      // Update existing paid membership
      await db(t('memberships')).where('id', existing.id).update({
        tier: targetTier,
        apple_subscription_id: receipt_data || existing.apple_subscription_id,
        price_cents: tierConfig.price_cents,
        cancelled_at: null,
        updated_at: now,
      });
    } else {
      // Cancel existing free membership if any
      if (existing) {
        await db(t('memberships')).where('id', existing.id).update({
          status: 'expired',
          updated_at: now,
        });
      }

      // Create new paid membership
      await db(t('memberships')).insert({
        user_id: userId,
        tier: targetTier,
        status: 'active',
        apple_subscription_id: receipt_data || null,
        started_at: now,
        expires_at: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000), // 30 days
        price_cents: tierConfig.price_cents,
        currency: 'EUR',
        created_at: now,
        updated_at: now,
      });
    }

    // Record payment
    await db(t('payments')).insert({
      uuid: require('uuid').v4(),
      user_id: userId,
      payment_type: 'membership',
      amount_cents: tierConfig.price_cents,
      discount_cents: 0,
      net_amount_cents: tierConfig.price_cents,
      currency: 'EUR',
      payment_method: 'apple_pay',
      status: 'succeeded',
      paid_at: now,
      created_at: now,
      updated_at: now,
    });

    const action = isUpgrade ? 'membership.upgraded' : isDowngrade ? 'membership.downgraded' : 'membership.subscribed';

    await AuditService.logFromRequest(req, action, 'membership', null, {
      metadata: {
        previous_tier: previousTier,
        new_tier: targetTier,
        product_id,
        price_cents: tierConfig.price_cents,
      },
    });

    res.json({
      success: true,
      data: {
        tier: targetTier,
        tier_name: tierConfig.name,
        status: 'active',
        is_upgrade: isUpgrade,
        is_downgrade: isDowngrade,
        price_cents: tierConfig.price_cents,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ============================================================
// 4. CANCEL MEMBERSHIP
// ============================================================

membershipRouter.put('/cancel', authenticate, paymentsRequired, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const { reason, feedback } = req.body || {};
    const now = new Date();

    const membership = await db(t('memberships'))
      .where('user_id', userId)
      .where('status', 'active')
      .whereNot('tier', 'free')
      .first();

    if (!membership) {
      throw AppError.badRequest('No active paid membership to cancel');
    }

    // Mark as cancelled (membership remains active until expires_at)
    await db(t('memberships')).where('id', membership.id).update({
      cancelled_at: now,
      updated_at: now,
    });

    // Note: In production, don't immediately downgrade.
    // Keep active until expires_at, then the cron job downgrades to free.
    // For now, we show cancellation info.

    await AuditService.logFromRequest(req, 'membership.cancelled', 'membership', membership.id, {
      metadata: {
        tier: membership.tier,
        reason,
        feedback,
        expires_at: membership.expires_at,
      },
    });

    res.json({
      success: true,
      data: {
        message: 'Mitgliedschaft gekündigt',
        detail: 'Deine Mitgliedschaft bleibt bis zum Ende des aktuellen Abrechnungszeitraums aktiv.',
        tier: membership.tier,
        active_until: membership.expires_at,
        apple_subscription_info: membership.apple_subscription_id
          ? 'Bitte kündige auch dein Abo in den iOS-Einstellungen unter Abos.'
          : null,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ============================================================
// 5. RESTORE CANCELLED MEMBERSHIP
// ============================================================

membershipRouter.put('/restore', authenticate, paymentsRequired, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const now = new Date();

    const membership = await db(t('memberships'))
      .where('user_id', userId)
      .where('status', 'active')
      .whereNotNull('cancelled_at')
      .first();

    if (!membership) {
      throw AppError.badRequest('No cancelled membership to restore');
    }

    await db(t('memberships')).where('id', membership.id).update({
      cancelled_at: null,
      updated_at: now,
    });

    await AuditService.logFromRequest(req, 'membership.restored', 'membership', membership.id, {
      metadata: { tier: membership.tier },
    });

    res.json({
      success: true,
      data: {
        message: 'Mitgliedschaft wiederhergestellt',
        tier: membership.tier,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ============================================================
// 6. PURCHASE HISTORY
// ============================================================

membershipRouter.get('/history', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const { page = 1, per_page = 20 } = req.query;

    // All memberships (current and past)
    const memberships = await db(t('memberships'))
      .where('user_id', userId)
      .orderBy('created_at', 'desc');

    // All membership-related payments
    let paymentQuery = db(t('payments'))
      .where('user_id', userId)
      .where('payment_type', 'membership')
      .orderBy('created_at', 'desc');

    const countQuery = paymentQuery.clone();
    const [{ count: total }] = await countQuery.count('* as count');
    const offset = (Number(page) - 1) * Number(per_page);

    const payments = await paymentQuery
      .limit(Number(per_page))
      .offset(offset);

    // All tournament fee payments
    const tournamentPayments = await db(t('payments'))
      .where('user_id', userId)
      .where('payment_type', 'tournament_fee')
      .where('status', 'succeeded')
      .select(
        db.raw('COUNT(*) as total_count'),
        db.raw('SUM(net_amount_cents) as total_paid'),
        db.raw('SUM(discount_cents) as total_discount')
      )
      .first();

    res.json({
      success: true,
      data: {
        membership_history: memberships.map((m: any) => ({
          id: m.id,
          tier: m.tier,
          status: m.status,
          started_at: m.started_at,
          expires_at: m.expires_at,
          cancelled_at: m.cancelled_at,
          price_cents: m.price_cents,
          currency: m.currency,
        })),
        payments: payments.map((p: any) => ({
          id: p.id,
          amount_cents: p.net_amount_cents,
          currency: p.currency,
          status: p.status,
          payment_method: p.payment_method,
          paid_at: p.paid_at,
          receipt_url: p.receipt_url,
        })),
        tournament_summary: {
          total_tournaments: Number(tournamentPayments?.total_count || 0),
          total_paid_cents: Number(tournamentPayments?.total_paid || 0),
          total_discount_cents: Number(tournamentPayments?.total_discount || 0),
        },
      },
      meta: {
        page: Number(page),
        per_page: Number(per_page),
        total: Number(total),
        total_pages: Math.ceil(Number(total) / Number(per_page)),
      },
    });
  } catch (error) {
    next(error);
  }
});

// ============================================================
// 7. BENEFITS CHECK (for registration flow)
// ============================================================

membershipRouter.get('/benefits-check/:eventId', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const eventId = parseInt(req.params.eventId, 10);

    const event = await db(t('events')).where('id', eventId).first();
    if (!event) throw AppError.notFound('Event');

    const membership = await db(t('memberships'))
      .where('user_id', userId)
      .where('status', 'active')
      .first();

    const tier = (membership?.tier || 'free') as keyof typeof TIER_CONFIG;
    const tierConfig = TIER_CONFIG[tier];

    // Calculate discount
    const discountPercent = tierConfig.discount_percent;
    const originalFee = event.entry_fee_cents;
    const discountAmount = Math.round(originalFee * (discountPercent / 100));
    const finalFee = originalFee - discountAmount;

    // Check early access
    const now = new Date();
    const registrationOpens = new Date(event.registration_opens_at);
    const earlyAccessDate = new Date(
      registrationOpens.getTime() - tierConfig.early_access_hours * 60 * 60 * 1000
    );
    const hasEarlyAccess = tierConfig.early_access_hours > 0 && now >= earlyAccessDate;
    const earlyAccessActive = now >= earlyAccessDate && now < registrationOpens;

    // Check access type restrictions
    let accessAllowed = true;
    let accessMessage = '';
    if (event.access_type === 'club_only' && tier !== 'club') {
      accessAllowed = false;
      accessMessage = 'Dieses Turnier ist nur für Club-Mitglieder zugänglich.';
    } else if (event.access_type === 'members_only' && tier === 'free') {
      accessAllowed = false;
      accessMessage = 'Dieses Turnier ist nur für Mitglieder (Plus/Club) zugänglich.';
    }

    // Upsell opportunity
    let upsell = null;
    if (tier === 'free' && originalFee > 0) {
      const plusDiscount = Math.round(originalFee * 0.1);
      const clubDiscount = Math.round(originalFee * 0.2);
      upsell = {
        message: 'Mit einer Mitgliedschaft sparst du bei diesem Turnier!',
        plus_savings_cents: plusDiscount,
        club_savings_cents: clubDiscount,
      };
    } else if (tier === 'plus' && originalFee > 0) {
      const extraDiscount = Math.round(originalFee * 0.1);
      upsell = {
        message: 'Upgrade auf Club für 20% statt 10% Rabatt!',
        additional_savings_cents: extraDiscount,
      };
    }

    res.json({
      success: true,
      data: {
        tier,
        tier_name: tierConfig.name,
        original_fee_cents: originalFee,
        discount_percent: discountPercent,
        discount_amount_cents: discountAmount,
        final_fee_cents: finalFee,
        early_access: {
          hours: tierConfig.early_access_hours,
          available_from: earlyAccessDate,
          has_access: hasEarlyAccess,
          currently_active: earlyAccessActive,
        },
        access: {
          allowed: accessAllowed,
          message: accessMessage,
          event_access_type: event.access_type,
        },
        waitlist_priority: tierConfig.waitlist_priority,
        upsell,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ============================================================
// 8. APPLE SUBSCRIPTION MANAGEMENT INFO
// ============================================================

membershipRouter.get('/apple-subscription-info', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;

    const membership = await db(t('memberships'))
      .where('user_id', userId)
      .where('status', 'active')
      .whereNot('tier', 'free')
      .first();

    if (!membership) {
      res.json({
        success: true,
        data: {
          has_subscription: false,
          management_url: 'https://apps.apple.com/account/subscriptions',
          instructions: 'Du hast derzeit kein aktives Abo.',
        },
      });
      return;
    }

    res.json({
      success: true,
      data: {
        has_subscription: true,
        tier: membership.tier,
        apple_subscription_id: membership.apple_subscription_id,
        management_url: 'https://apps.apple.com/account/subscriptions',
        instructions_cancel: 'Um dein Abo zu kündigen, öffne die iOS-Einstellungen → Apple-ID → Abos → Tourneo → Abo kündigen.',
        instructions_upgrade: 'Um dein Abo zu ändern, kannst du direkt in der App upgraden oder downgraden.',
        instructions_restore: 'Falls dein Abo nicht erkannt wird, nutze "Käufe wiederherstellen" in den Profileinstellungen.',
        expires_at: membership.expires_at,
        cancelled_at: membership.cancelled_at,
        is_cancelled: !!membership.cancelled_at,
      },
    });
  } catch (error) {
    next(error);
  }
});

export { membershipRouter };