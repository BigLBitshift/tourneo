import { db, t } from '../config/database';
import { NotificationService } from './notificationService';
import { RatingHistoryService } from './ratingHistoryService';

const TOP_SNAPSHOT = 100;

function quarterCode(d: Date): string {
  return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`;
}
function quarterBounds(d: Date): { start: Date; end: Date } {
  const q = Math.floor(d.getMonth() / 3);
  const start = new Date(d.getFullYear(), q * 3, 1);
  const end = new Date(d.getFullYear(), q * 3 + 3, 1);
  return { start, end };
}

/**
 * SeasonService — quarterly ranked seasons with soft reset.
 *
 * rollover() is idempotent and cron-safe (runs daily):
 *   - ensures an active season row exists for the current quarter
 *   - when the active season's end passed: snapshots the top 100 per
 *     sport into season_results, soft-resets every rated player's ELO
 *     halfway toward 1000 (keeps skill ordering, compresses spread),
 *     notifies podium players, opens the next season.
 */
export class SeasonService {
  static async getCurrent() {
    return db(t('seasons')).where('status', 'active').orderBy('starts_at', 'desc').first();
  }

  static async rollover(now: Date = new Date()): Promise<{ rolled: boolean }> {
    const active = await this.getCurrent();

    if (!active) {
      const { start, end } = quarterBounds(now);
      await db(t('seasons')).insert({
        code: quarterCode(now),
        starts_at: start,
        ends_at: end,
        status: 'active',
        created_at: now,
      });
      return { rolled: false };
    }

    if (new Date(active.ends_at) > now) return { rolled: false };

    // Season over — snapshot, reset, advance.
    for (const sport of ['padel', 'fifa'] as const) {
      const eloCol = sport === 'padel' ? 'elo_padel' : 'elo_fifa';
      const top = await db(`${t('profiles')} as p`)
        .join(`${t('users')} as u`, 'u.id', 'p.user_id')
        .where('p.elo_matches_played', '>', 0)
        .whereNull('u.deleted_at')
        .where('u.status', 'active')
        .orderBy(`p.${eloCol}`, 'desc')
        .limit(TOP_SNAPSHOT)
        .select('p.user_id', `p.${eloCol} as elo`, 'p.city');

      if (top.length) {
        await db(t('season_results')).insert(
          top.map((row: any, idx: number) => ({
            season_id: active.id,
            user_id: row.user_id,
            sport,
            final_elo: Number(row.elo ?? 1000),
            final_rank: idx + 1,
            city: row.city ?? null,
            created_at: now,
          }))
        );
      }

      for (const [idx, row] of top.slice(0, 3).entries()) {
        NotificationService.send(
          row.user_id,
          'general',
          `Saison ${active.code} beendet! 🏅`,
          `Du hast die Saison auf Rang ${idx + 1} (${sport === 'padel' ? 'Padel' : 'FIFA'}) abgeschlossen. Stark!`,
          { season: active.code, rank: idx + 1, sport }
        ).catch(() => {});
      }

      // Soft reset: elo' = 1000 + (elo - 1000) / 2, recorded in history.
      const rated = await db(t('profiles'))
        .where('elo_matches_played', '>', 0)
        .select('user_id', `${eloCol} as elo`);
      for (const row of rated) {
        const oldElo = Number(row.elo ?? 1000);
        const newElo = Math.round(1000 + (oldElo - 1000) / 2);
        if (newElo === oldElo) continue;
        await db(t('profiles')).where('user_id', row.user_id).update({
          [eloCol]: newElo,
          updated_at: now,
        });
        await RatingHistoryService.record(
          row.user_id,
          sport,
          newElo,
          newElo - oldElo,
          'seed'
        ).catch(() => {});
      }
    }

    const { start, end } = quarterBounds(now);
    await db.transaction(async (trx) => {
      await trx(t('seasons')).where('id', active.id).update({ status: 'completed' });
      await trx(t('seasons')).insert({
        code: quarterCode(now),
        starts_at: start,
        ends_at: end,
        status: 'active',
        created_at: now,
      });
    });

    return { rolled: true };
  }

  static async getUserSeasonHistory(userId: number) {
    return db(`${t('season_results')} as r`)
      .join(`${t('seasons')} as s`, 's.id', 'r.season_id')
      .where('r.user_id', userId)
      .orderBy('s.starts_at', 'desc')
      .select('s.code', 'r.sport', 'r.final_elo', 'r.final_rank', 'r.city');
  }
}
