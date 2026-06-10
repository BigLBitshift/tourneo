import { db, t } from '../config/database';
import { NotificationService } from './notificationService';

/** ISO week key like "2026-W24" (week starts Monday). */
export function isoWeek(d: Date): string {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function previousIsoWeek(d: Date): string {
  return isoWeek(new Date(d.getTime() - 7 * 24 * 60 * 60 * 1000));
}

/**
 * StreakService — Duolingo-style weekly play streaks.
 *
 * recordPlayed() is called from the post-result hook for every player of
 * a completed match:
 *   - same week as last play → no change
 *   - exactly the following week → streak + 1
 *   - gap → streak resets to 1
 *
 * warnAtRisk() (cron, daily) pushes Fri–Sun to players whose streak ≥ 2
 * and who haven't played this week yet — once per week max.
 */
export class StreakService {
  static async recordPlayed(userIds: number[], now: Date = new Date()): Promise<void> {
    const week = isoWeek(now);
    const prevWeek = previousIsoWeek(now);

    for (const userId of userIds) {
      const profile = await db(t('profiles')).where('user_id', userId).first();
      if (!profile) continue;
      if (profile.last_played_week === week) continue;

      const newStreak = profile.last_played_week === prevWeek
        ? Number(profile.week_streak ?? 0) + 1
        : 1;
      const longest = Math.max(newStreak, Number(profile.longest_week_streak ?? 0));

      await db(t('profiles')).where('user_id', userId).update({
        week_streak: newStreak,
        longest_week_streak: longest,
        last_played_week: week,
        updated_at: now,
      });

      // Celebrate milestones (4, 8, 12 … weeks).
      if (newStreak >= 4 && newStreak % 4 === 0) {
        NotificationService.send(
          userId,
          'general',
          `${newStreak} Wochen in Folge! 🔥`,
          'Deine Spiel-Serie läuft. Weiter so!',
          { streak: newStreak }
        ).catch(() => {});
      }
    }
  }

  static async warnAtRisk(now: Date = new Date()): Promise<number> {
    // Only nag towards the end of the week (Fri=5, Sat=6, Sun=0).
    const dow = now.getDay();
    if (dow !== 5 && dow !== 6 && dow !== 0) return 0;

    const week = isoWeek(now);
    const prevWeek = previousIsoWeek(now);
    const weekAgo = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);

    const atRisk = await db(t('profiles'))
      .where('week_streak', '>=', 2)
      .where('last_played_week', prevWeek) // streak intact, but idle this week
      .where((q) => {
        q.whereNull('streak_warned_at').orWhere('streak_warned_at', '<', weekAgo);
      })
      .select('user_id', 'week_streak');

    let warned = 0;
    for (const p of atRisk) {
      try {
        await NotificationService.send(
          p.user_id,
          'general',
          'Deine Serie ist in Gefahr! ⏳',
          `${p.week_streak} Wochen in Folge gespielt — spiel noch diese Woche, um die Serie zu halten.`,
          { streak: p.week_streak, week }
        );
        await db(t('profiles')).where('user_id', p.user_id).update({
          streak_warned_at: now,
          updated_at: now,
        });
        warned++;
      } catch (err) {
        console.warn('[streaks] warn push failed:', (err as Error).message);
      }
    }
    return warned;
  }
}
