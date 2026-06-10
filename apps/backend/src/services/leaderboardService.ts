import { db, t } from '../config/database';
import { EloService, type EloSport } from './eloService';

export interface LeaderboardEntry {
  rank: number;
  user_id: number;
  name: string;
  avatar_url: string | null;
  city: string | null;
  elo: number;
  tier: string;
  matches_played: number;
}

/**
 * LeaderboardService — verified city/region/global rankings.
 *
 * Only surfaces players who opted into discovery (profiles.discoverable)
 * and have actually played (elo_matches_played > 0), so the board shows
 * real competitors instead of thousands of untouched default-ELO accounts.
 */
export class LeaderboardService {
  static async top(opts: {
    sport: EloSport;
    city?: string;
    limit?: number;
  }): Promise<{ sport: EloSport; city: string | null; entries: LeaderboardEntry[] }> {
    const eloCol = opts.sport === 'padel' ? 'elo_padel' : 'elo_fifa';
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);

    let query = db(`${t('profiles')} as p`)
      .join(`${t('users')} as u`, 'u.id', 'p.user_id')
      .where('p.discoverable', true)
      .where('p.elo_matches_played', '>', 0)
      .whereNull('u.deleted_at')
      .where('u.status', 'active')
      .orderBy(`p.${eloCol}`, 'desc')
      .limit(limit)
      .select(
        'p.user_id',
        'p.display_name',
        'p.first_name',
        'p.last_name',
        'p.avatar_url',
        'p.city',
        `p.${eloCol} as elo`,
        'p.elo_matches_played as matches_played'
      );

    if (opts.city) {
      query = query.whereRaw('LOWER(p.city) = ?', [opts.city.toLowerCase().trim()]);
    }

    const rows = await query;

    const entries: LeaderboardEntry[] = rows.map((r: any, idx: number) => {
      const elo = Number(r.elo ?? 1000);
      return {
        rank: idx + 1,
        user_id: r.user_id,
        name: r.display_name || [r.first_name, r.last_name].filter(Boolean).join(' ') || 'Spieler',
        avatar_url: r.avatar_url ?? null,
        city: r.city ?? null,
        elo,
        tier: EloService.getTier(elo),
        matches_played: Number(r.matches_played ?? 0),
      };
    });

    return { sport: opts.sport, city: opts.city ?? null, entries };
  }

  /**
   * The viewer's own rank within a board (city or global). Returns null
   * when the user is not discoverable or hasn't played yet.
   */
  static async rankOf(userId: number, sport: EloSport, city?: string): Promise<number | null> {
    const eloCol = sport === 'padel' ? 'elo_padel' : 'elo_fifa';

    const me = await db(t('profiles')).where('user_id', userId).first();
    if (!me || !me.discoverable || !(me.elo_matches_played > 0)) return null;
    const myElo = Number(me[eloCol] ?? 1000);

    let query = db(`${t('profiles')} as p`)
      .join(`${t('users')} as u`, 'u.id', 'p.user_id')
      .where('p.discoverable', true)
      .where('p.elo_matches_played', '>', 0)
      .whereNull('u.deleted_at')
      .where('u.status', 'active')
      .where(`p.${eloCol}`, '>', myElo);

    if (city) {
      query = query.whereRaw('LOWER(p.city) = ?', [city.toLowerCase().trim()]);
    }

    const [{ count }] = await query.count('* as count');
    return Number(count) + 1;
  }
}
