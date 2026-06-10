import { db, t } from '../config/database';
import { NotificationService } from './notificationService';
import type { EloSport } from './eloService';

/**
 * RivalService — re-engagement pushes built on data we already have.
 *
 * After a match changes a player's ELO, we check whether they just
 * overtook any of their friends (accepted friendships). The overtaken
 * friend gets a push — "Max ist mit 1240 an dir vorbeigezogen" is the
 * single most effective reactivation trigger a competitive app has.
 *
 * Called best-effort from the post-result hooks in bracketService; a
 * failure here must never break result entry.
 */
export class RivalService {
  static async notifyOvertakenRivals(
    winnerUserId: number,
    sport: EloSport,
    oldElo: number,
    newElo: number
  ): Promise<number> {
    if (newElo <= oldElo) return 0;

    const eloCol = sport === 'padel' ? 'elo_padel' : 'elo_fifa';

    const winnerProfile = await db(t('profiles')).where('user_id', winnerUserId).first();
    if (!winnerProfile) return 0;
    const winnerName =
      winnerProfile.display_name ||
      [winnerProfile.first_name, winnerProfile.last_name].filter(Boolean).join(' ') ||
      'Ein Rivale';

    // Friends in either direction with accepted status whose ELO sits in
    // the window the winner just crossed — they were ahead before this
    // match and are behind now.
    const friendIds: number[] = (
      await db(t('friendships'))
        .where('status', 'accepted')
        .where((q) => {
          q.where('requester_id', winnerUserId).orWhere('addressee_id', winnerUserId);
        })
        .select('requester_id', 'addressee_id')
    ).flatMap((f: any) =>
      [f.requester_id, f.addressee_id].filter((id: number) => id !== winnerUserId)
    );

    if (!friendIds.length) return 0;

    const overtaken = await db(t('profiles'))
      .whereIn('user_id', friendIds)
      .where(eloCol, '>', oldElo)
      .where(eloCol, '<=', newElo)
      .select('user_id');

    let sent = 0;
    for (const row of overtaken) {
      try {
        await NotificationService.send(
          row.user_id,
          'general',
          'Du wurdest überholt! 🏃',
          `${winnerName} ist mit ${newElo} ELO an dir vorbeigezogen. Zeit für eine Revanche?`,
          { rival_user_id: winnerUserId, sport }
        );
        sent++;
      } catch (err) {
        console.warn('[rivals] failed to notify overtaken friend:', err);
      }
    }
    return sent;
  }
}
