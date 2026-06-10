import { db, t } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { generateAmericanoRounds } from '../utils/scheduling';

/**
 * AmericanoService — the rotating-partner padel format.
 *
 * Every round players get a new partner; points are accumulated
 * individually (each player earns their team's score for the round).
 * Americano matches reference individual users (not registrations),
 * because the pairs change every round and never form a stable "team".
 */
export class AmericanoService {
  static async createSession(
    eventId: number,
    options: { rounds_count?: number; courts_count?: number; points_per_match?: number },
    userId: number
  ) {
    const event = await db(t('events')).where('id', eventId).first();
    if (!event) throw AppError.notFound('Event');

    const existing = await db(t('americano_sessions')).where('event_id', eventId).first();
    if (existing && existing.status !== 'draft') {
      throw AppError.badRequest('Americano session has already started');
    }

    const registrations = await db(t('registrations'))
      .where('event_id', eventId)
      .where('status', 'confirmed')
      .where('checked_in', true)
      .orderBy('created_at', 'asc')
      .select('user_id');

    const players: number[] = registrations.map((r: any) => r.user_id);
    if (players.length < 4) {
      throw AppError.badRequest('Americano requires at least 4 checked-in participants');
    }

    const courtsCount = Math.max(1, options.courts_count ?? Math.floor(players.length / 4));
    // Default: enough rounds for plenty of partner rotation without
    // dragging on — players.length - 1 caps at "everyone partnered once".
    const roundsCount = Math.max(1, Math.min(options.rounds_count ?? Math.min(players.length - 1, 8), 20));
    const pointsPerMatch = Math.max(4, Math.min(options.points_per_match ?? 16, 64));

    const plan = generateAmericanoRounds<number>(players, roundsCount, courtsCount);
    const now = new Date();

    const sessionId = await db.transaction(async (trx) => {
      if (existing) {
        await trx(t('americano_matches')).where('session_id', existing.id).del();
        await trx(t('americano_sessions')).where('id', existing.id).del();
      }

      const [id] = await trx(t('americano_sessions')).insert({
        event_id: eventId,
        courts_count: courtsCount,
        points_per_match: pointsPerMatch,
        rounds_count: roundsCount,
        status: 'in_progress',
        created_by: userId,
        created_at: now,
        updated_at: now,
      });

      const matchRows = plan.flatMap((roundPlan, idx) =>
        roundPlan.matches.map((m) => ({
          session_id: id,
          round_number: idx + 1,
          court_number: m.court,
          team_a_player_1: m.teamA[0],
          team_a_player_2: m.teamA[1] ?? null,
          team_b_player_1: m.teamB[0],
          team_b_player_2: m.teamB[1] ?? null,
          status: 'upcoming',
          created_at: now,
          updated_at: now,
        }))
      );
      if (matchRows.length) {
        await trx(t('americano_matches')).insert(matchRows);
      }

      await trx(t('audit_log')).insert({
        user_id: userId,
        action: 'americano.session_created',
        entity_type: 'event',
        entity_id: eventId,
        new_values: JSON.stringify({
          players: players.length,
          rounds: roundsCount,
          courts: courtsCount,
        }),
        created_at: now,
      });

      return id as number;
    });

    return this.getSession(eventId, sessionId);
  }

  static async getSessionByEvent(eventId: number) {
    const session = await db(t('americano_sessions')).where('event_id', eventId).first();
    if (!session) throw AppError.notFound('Americano session');
    return this.getSession(eventId, session.id);
  }

  private static async getSession(eventId: number, sessionId: number) {
    const session = await db(t('americano_sessions')).where('id', sessionId).first();
    if (!session) throw AppError.notFound('Americano session');

    const matches = await db(t('americano_matches'))
      .where('session_id', sessionId)
      .orderBy('round_number', 'asc')
      .orderBy('court_number', 'asc');

    const userIds = new Set<number>();
    for (const m of matches) {
      for (const key of ['team_a_player_1', 'team_a_player_2', 'team_b_player_1', 'team_b_player_2']) {
        if (m[key]) userIds.add(m[key]);
      }
    }
    const profiles = userIds.size
      ? await db(t('profiles'))
          .whereIn('user_id', [...userIds])
          .select('user_id', 'display_name', 'first_name', 'last_name', 'avatar_url')
      : [];
    const profileOf = new Map<number, any>(profiles.map((p: any) => [p.user_id, p]));
    const playerInfo = (uid: number | null) => {
      if (!uid) return null;
      const p = profileOf.get(uid);
      return {
        user_id: uid,
        name: p?.display_name || [p?.first_name, p?.last_name].filter(Boolean).join(' ') || 'Spieler',
        avatar_url: p?.avatar_url ?? null,
      };
    };

    return {
      id: session.id,
      event_id: eventId,
      status: session.status,
      courts_count: session.courts_count,
      rounds_count: session.rounds_count,
      points_per_match: session.points_per_match,
      matches: matches.map((m: any) => ({
        id: m.id,
        round_number: m.round_number,
        court_number: m.court_number,
        team_a: [playerInfo(m.team_a_player_1), playerInfo(m.team_a_player_2)].filter(Boolean),
        team_b: [playerInfo(m.team_b_player_1), playerInfo(m.team_b_player_2)].filter(Boolean),
        score_a: m.score_a,
        score_b: m.score_b,
        status: m.status,
      })),
    };
  }

  /**
   * Records the result of one Americano match. Allowed for any player in
   * the match or an admin. The two team scores must add up to the
   * session's points_per_match (classic Americano scoring, e.g. 16).
   */
  static async enterScore(matchId: number, scoreA: number, scoreB: number, userId: number) {
    const match = await db(t('americano_matches')).where('id', matchId).first();
    if (!match) throw AppError.notFound('Match');

    const session = await db(t('americano_sessions')).where('id', match.session_id).first();
    if (!session) throw AppError.notFound('Americano session');
    if (session.status === 'completed') {
      throw AppError.badRequest('Session is already completed');
    }

    const user = await db(t('users')).where('id', userId).first();
    const isAdmin = user && (user.role === 'admin' || user.role === 'superadmin');
    const isParticipant = [
      match.team_a_player_1,
      match.team_a_player_2,
      match.team_b_player_1,
      match.team_b_player_2,
    ].includes(userId);
    if (!isAdmin && !isParticipant) {
      throw AppError.forbidden('Only match participants or admins can enter scores');
    }

    if (!Number.isInteger(scoreA) || !Number.isInteger(scoreB) || scoreA < 0 || scoreB < 0) {
      throw AppError.badRequest('Scores must be non-negative integers');
    }
    if (scoreA + scoreB !== session.points_per_match) {
      throw AppError.badRequest(
        `Scores must add up to ${session.points_per_match} (got ${scoreA + scoreB})`
      );
    }

    const now = new Date();
    await db(t('americano_matches')).where('id', matchId).update({
      score_a: scoreA,
      score_b: scoreB,
      status: 'completed',
      completed_at: now,
      updated_at: now,
    });

    // Auto-complete the session when the last match is scored.
    const [{ count: remaining }] = await db(t('americano_matches'))
      .where('session_id', session.id)
      .where('status', '!=', 'completed')
      .count('* as count');
    if (Number(remaining) === 0) {
      await db(t('americano_sessions')).where('id', session.id).update({
        status: 'completed',
        updated_at: now,
      });
    }

    return { id: matchId, score_a: scoreA, score_b: scoreB, status: 'completed' };
  }

  /**
   * Individual standings: every player accumulates their team's points
   * from each completed match. Ranked by total points.
   */
  static async getStandings(eventId: number) {
    const session = await db(t('americano_sessions')).where('event_id', eventId).first();
    if (!session) throw AppError.notFound('Americano session');

    const matches = await db(t('americano_matches'))
      .where('session_id', session.id)
      .where('status', 'completed');

    const totals = new Map<number, { points: number; played: number; wins: number }>();
    const add = (uid: number | null, points: number, won: boolean) => {
      if (!uid) return;
      const row = totals.get(uid) ?? { points: 0, played: 0, wins: 0 };
      row.points += points;
      row.played += 1;
      if (won) row.wins += 1;
      totals.set(uid, row);
    };

    for (const m of matches) {
      const aWon = (m.score_a ?? 0) > (m.score_b ?? 0);
      add(m.team_a_player_1, m.score_a ?? 0, aWon);
      add(m.team_a_player_2, m.score_a ?? 0, aWon);
      add(m.team_b_player_1, m.score_b ?? 0, !aWon);
      add(m.team_b_player_2, m.score_b ?? 0, !aWon);
    }

    const userIds = [...totals.keys()];
    const profiles = userIds.length
      ? await db(t('profiles'))
          .whereIn('user_id', userIds)
          .select('user_id', 'display_name', 'first_name', 'last_name', 'avatar_url')
      : [];
    const profileOf = new Map<number, any>(profiles.map((p: any) => [p.user_id, p]));

    const standings = userIds
      .map((uid) => {
        const row = totals.get(uid)!;
        const p = profileOf.get(uid);
        return {
          user_id: uid,
          name:
            p?.display_name || [p?.first_name, p?.last_name].filter(Boolean).join(' ') || 'Spieler',
          avatar_url: p?.avatar_url ?? null,
          points: row.points,
          played: row.played,
          wins: row.wins,
        };
      })
      .sort((a, b) => b.points - a.points || b.wins - a.wins)
      .map((row, idx) => ({ rank: idx + 1, ...row }));

    return {
      event_id: eventId,
      session_id: session.id,
      status: session.status,
      points_per_match: session.points_per_match,
      standings,
    };
  }
}
