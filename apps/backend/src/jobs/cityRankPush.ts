import { db, t } from '../config/database';
import { NotificationService } from '../services/notificationService';

const MIN_DAYS_BETWEEN_PUSHES = 6;

/**
 * Weekly-cadence re-engagement push for competitive players: when a
 * player's padel city rank got worse since the last snapshot, they get
 * "Du bist in <Stadt> auf Rang N abgerutscht".
 *
 * The job runs daily; the per-user cadence is enforced via
 * city_rank_notified_at (min 6 days between pushes), so a player gets
 * at most one rank push per week even though we snapshot every day.
 *
 * Ranks are computed per city across discoverable players with at
 * least one rated match — identical to the leaderboard's filter, so
 * the push number always matches what the user sees on the board.
 */
export async function pushCityRankChanges(now: Date = new Date()): Promise<number> {
  // All ranked players, grouped per city in one query.
  const players: Array<{
    user_id: number;
    city: string;
    elo_padel: number;
    city_rank_padel: number | null;
    city_rank_notified_at: Date | null;
  }> = await db(`${t('profiles')} as p`)
    .join(`${t('users')} as u`, 'u.id', 'p.user_id')
    .where('p.discoverable', true)
    .where('p.elo_matches_played', '>', 0)
    .whereNotNull('p.city')
    .whereNull('u.deleted_at')
    .where('u.status', 'active')
    .select('p.user_id', 'p.city', 'p.elo_padel', 'p.city_rank_padel', 'p.city_rank_notified_at');

  // Compute current rank per city (1-based, ELO descending).
  const byCity = new Map<string, typeof players>();
  for (const p of players) {
    const key = p.city.toLowerCase().trim();
    if (!byCity.has(key)) byCity.set(key, []);
    byCity.get(key)!.push(p);
  }

  const cutoff = new Date(now.getTime() - MIN_DAYS_BETWEEN_PUSHES * 24 * 60 * 60 * 1000);
  let pushed = 0;

  for (const cityPlayers of byCity.values()) {
    cityPlayers.sort((a, b) => Number(b.elo_padel ?? 0) - Number(a.elo_padel ?? 0));

    for (let i = 0; i < cityPlayers.length; i++) {
      const p = cityPlayers[i];
      const newRank = i + 1;
      const oldRank = p.city_rank_padel;

      const dropped = oldRank !== null && newRank > oldRank;
      const cooldownOver = !p.city_rank_notified_at || new Date(p.city_rank_notified_at) < cutoff;

      try {
        if (dropped && cooldownOver) {
          await NotificationService.send(
            p.user_id,
            'general',
            'Du bist abgerutscht! 📉',
            `Du bist in ${p.city} von Rang ${oldRank} auf Rang ${newRank} gefallen. Zeit für ein Match!`,
            { city: p.city, old_rank: oldRank, new_rank: newRank }
          );
          await db(t('profiles')).where('user_id', p.user_id).update({
            city_rank_padel: newRank,
            city_rank_notified_at: now,
            updated_at: now,
          });
          pushed++;
        } else {
          // Always refresh the snapshot so next comparison is against
          // the latest standing — without notifying.
          await db(t('profiles')).where('user_id', p.user_id).update({
            city_rank_padel: newRank,
            updated_at: now,
          });
        }
      } catch (err) {
        console.error('[cityRankPush] failed for user', p.user_id, err);
      }
    }
  }

  return pushed;
}
