import { db, t } from '../config/database';
import { ModerationService } from './moderationService';
import { isoWeek } from './streakService';

/**
 * EngagementService — challenges and the activity feed.
 *
 * Both are computed on read from existing tables (matches, events,
 * achievements, friendships) instead of maintaining write-fanout
 * tables: zero write amplification, no consistency drift, and the
 * queries stay cheap because they're bounded to 7 days / the current
 * week.
 */
export class EngagementService {
  /** Weekly challenges with live progress for the current ISO week. */
  static async getWeeklyChallenges(userId: number, now: Date = new Date()) {
    const week = isoWeek(now);
    // Monday 00:00 of the current ISO week (local server time).
    const monday = new Date(now);
    const day = monday.getDay() || 7;
    monday.setDate(monday.getDate() - day + 1);
    monday.setHours(0, 0, 0, 0);

    const regs: number[] = await db(t('registrations'))
      .where('user_id', userId)
      .orWhere('partner_user_id', userId)
      .pluck('id');

    let played = 0;
    let won = 0;
    const opponents = new Set<number>();

    if (regs.length) {
      const matches = await db(t('matches'))
        .where('status', 'completed')
        .where('completed_at', '>=', monday)
        .where((q) => {
          q.whereIn('participant_1_registration_id', regs).orWhereIn(
            'participant_2_registration_id',
            regs
          );
        })
        .select(
          'participant_1_registration_id',
          'participant_2_registration_id',
          'winner_registration_id'
        );

      for (const m of matches) {
        const mine = regs.includes(m.participant_1_registration_id)
          ? m.participant_1_registration_id
          : m.participant_2_registration_id;
        const theirs =
          mine === m.participant_1_registration_id
            ? m.participant_2_registration_id
            : m.participant_1_registration_id;
        played++;
        if (m.winner_registration_id === mine) won++;
        if (theirs) opponents.add(theirs);
      }
    }

    const define = (
      id: string,
      title: string,
      target: number,
      progress: number
    ) => ({
      id,
      week,
      title,
      target,
      progress: Math.min(progress, target),
      completed: progress >= target,
    });

    return [
      define('play_2', 'Spiele 2 Matches diese Woche', 2, played),
      define('win_1', 'Gewinne 1 Match', 1, won),
      define('opponents_2', 'Spiele gegen 2 verschiedene Gegner', 2, opponents.size),
    ];
  }

  /**
   * Activity feed: friends' results, new tournaments in my city and
   * friends' achievements — last 7 days, newest first, capped at 50.
   */
  static async getFeed(userId: number, now: Date = new Date()) {
    const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // A blocked user must not reappear in the feed via a shared
    // friendship — blocking that only covers chat is not blocking.
    const hiddenUserIds = new Set(await ModerationService.hiddenUserIds(userId));

    const friendIds: number[] = (
      await db(t('friendships'))
        .where('status', 'accepted')
        .where((q) => {
          q.where('requester_id', userId).orWhere('addressee_id', userId);
        })
        .select('requester_id', 'addressee_id')
    )
      .flatMap((f: any) => [f.requester_id, f.addressee_id].filter((id: number) => id !== userId))
      .filter((id: number) => !hiddenUserIds.has(id));

    const items: Array<{ type: string; ts: string; payload: Record<string, unknown> }> = [];

    // 1) Friends' completed matches
    if (friendIds.length) {
      const friendRegs = await db(t('registrations'))
        .whereIn('user_id', friendIds)
        .pluck('id');
      if (friendRegs.length) {
        const matches = await db(`${t('matches')} as m`)
          .leftJoin(`${t('events')} as e`, 'e.id', 'm.event_id')
          .where('m.status', 'completed')
          .where('m.completed_at', '>=', since)
          .where((q) => {
            q.whereIn('m.participant_1_registration_id', friendRegs).orWhereIn(
              'm.participant_2_registration_id',
              friendRegs
            );
          })
          .orderBy('m.completed_at', 'desc')
          .limit(20)
          .select('m.id', 'm.completed_at', 'm.winner_registration_id', 'e.title as event_title');
        for (const m of matches) {
          items.push({
            type: 'friend_match',
            ts: new Date(m.completed_at).toISOString(),
            payload: { match_id: m.id, event_title: m.event_title },
          });
        }
      }

      // 2) Friends' new achievements
      const achievements = await db(`${t('achievements')} as a`)
        .leftJoin(`${t('profiles')} as p`, 'p.user_id', 'a.user_id')
        .whereIn('a.user_id', friendIds)
        .where('a.earned_at', '>=', since)
        .orderBy('a.earned_at', 'desc')
        .limit(15)
        .select('a.user_id', 'a.achievement_type', 'a.earned_at', 'p.display_name', 'p.first_name');
      for (const a of achievements) {
        items.push({
          type: 'friend_achievement',
          ts: new Date(a.earned_at).toISOString(),
          payload: {
            user_id: a.user_id,
            name: a.display_name || a.first_name || 'Spieler',
            achievement: a.achievement_type,
          },
        });
      }
    }

    // 3) New tournaments in my city
    const me = await db(t('profiles')).where('user_id', userId).first();
    if (me?.city) {
      const events = await db(`${t('events')} as e`)
        .leftJoin(`${t('venues')} as v`, 'v.id', 'e.venue_id')
        .whereIn('e.status', ['published', 'registration_open'])
        .where('e.published_at', '>=', since)
        .whereRaw('LOWER(v.address_city) = ?', [String(me.city).toLowerCase()])
        .orderBy('e.published_at', 'desc')
        .limit(15)
        .select('e.id', 'e.title', 'e.start_date', 'e.published_at');
      for (const e of events) {
        items.push({
          type: 'city_event',
          ts: new Date(e.published_at).toISOString(),
          payload: { event_id: e.id, title: e.title, start_date: e.start_date },
        });
      }
    }

    return items.sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 50);
  }
}
