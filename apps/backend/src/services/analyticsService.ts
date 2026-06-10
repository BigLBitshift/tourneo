import { db, t } from '../config/database';

/**
 * AnalyticsService — the numbers you steer the company by.
 *
 * Retention is approximated from audit_log 'user.login' events: a user
 * counts as D7-retained when they logged in 7–14 days after signup.
 * Good enough until a dedicated analytics pipeline exists.
 */
export class AnalyticsService {
  static async overview(now: Date = new Date()) {
    const d30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // ── Signups + D7 retention (cohort: signed up 7-37 days ago) ──
    const cohortStart = new Date(now.getTime() - 37 * 24 * 60 * 60 * 1000);
    const cohortEnd = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const cohort = await db(t('users'))
      .whereBetween('created_at', [cohortStart, cohortEnd])
      .whereNull('deleted_at')
      .select('id', 'created_at');

    let retained = 0;
    if (cohort.length) {
      const logins = await db(t('audit_log'))
        .where('action', 'user.login')
        .whereIn('user_id', cohort.map((u: any) => u.id))
        .where('created_at', '>=', cohortStart)
        .select('user_id', 'created_at');
      const loginsByUser = new Map<number, Date[]>();
      for (const l of logins) {
        if (!loginsByUser.has(l.user_id)) loginsByUser.set(l.user_id, []);
        loginsByUser.get(l.user_id)!.push(new Date(l.created_at));
      }
      for (const u of cohort) {
        const signup = new Date(u.created_at).getTime();
        const window = [signup + 7 * 86400000, signup + 14 * 86400000];
        const userLogins = loginsByUser.get(u.id) ?? [];
        if (userLogins.some((d) => d.getTime() >= window[0] && d.getTime() <= window[1])) {
          retained++;
        }
      }
    }

    // ── Tournament fill rate (completed events, last 90 days) ──
    const d90 = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const completedEvents = await db(t('events'))
      .where('status', 'completed')
      .where('end_date', '>=', d90)
      .select('id', 'max_participants');
    let fillRate: number | null = null;
    if (completedEvents.length) {
      const counts = await db(t('registrations'))
        .whereIn('event_id', completedEvents.map((e: any) => e.id))
        .whereIn('status', ['confirmed', 'no_show'])
        .groupBy('event_id')
        .select('event_id')
        .count('* as count');
      const countMap = new Map(counts.map((c: any) => [c.event_id, Number(c.count)]));
      const ratios = completedEvents.map(
        (e: any) => (countMap.get(e.id) ?? 0) / Math.max(1, e.max_participants)
      );
      fillRate = Math.round((ratios.reduce((a, b) => a + b, 0) / ratios.length) * 1000) / 10;
    }

    // ── Booking revenue per venue (confirmed in-app bookings, 30d) ──
    const bookingRevenue = await db(`${t('court_bookings')} as b`)
      .leftJoin(`${t('venues')} as v`, 'v.id', 'b.venue_id')
      .where('b.status', 'confirmed')
      .where('b.booked_at', '>=', d30)
      .groupBy('b.venue_id', 'v.name')
      .select('b.venue_id', 'v.name as venue_name')
      .sum('b.price_cents as revenue_cents')
      .count('b.id as bookings');

    // ── Tournament revenue (succeeded payments, 30d) ──
    const [tournamentRevenue] = await db(t('payments'))
      .where('status', 'succeeded')
      .where('payment_type', 'tournament_fee')
      .where('paid_at', '>=', d30)
      .sum('net_amount_cents as total');

    const [{ count: totalUsers }] = await db(t('users'))
      .whereNull('deleted_at')
      .where('status', 'active')
      .count('* as count');
    const [{ count: newUsers30d }] = await db(t('users'))
      .where('created_at', '>=', d30)
      .whereNull('deleted_at')
      .count('* as count');
    const [{ count: matches30d }] = await db(t('matches'))
      .where('status', 'completed')
      .where('completed_at', '>=', d30)
      .count('* as count');

    return {
      users: {
        total: Number(totalUsers),
        new_30d: Number(newUsers30d),
        d7_retention_percent: cohort.length
          ? Math.round((retained / cohort.length) * 1000) / 10
          : null,
        cohort_size: cohort.length,
      },
      tournaments: {
        fill_rate_percent: fillRate,
        completed_90d: completedEvents.length,
        revenue_30d_cents: Number(tournamentRevenue?.total ?? 0),
      },
      bookings: {
        matches_completed_30d: Number(matches30d),
        revenue_by_venue: bookingRevenue.map((r: any) => ({
          venue_id: r.venue_id,
          venue_name: r.venue_name,
          revenue_cents: Number(r.revenue_cents ?? 0),
          bookings: Number(r.bookings),
        })),
      },
    };
  }
}
