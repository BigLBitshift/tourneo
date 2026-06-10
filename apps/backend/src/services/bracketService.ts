import { v4 as uuidv4 } from 'uuid';
import { db, t } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { EloService } from './eloService';
import { AchievementService } from './achievementService';
import { NotificationService } from './notificationService';
import { generateRoundRobinPairings } from '../utils/scheduling';

interface BracketMatch {
  round: number;
  matchNumber: number;
  roundName: string;
  participant1RegId: number | null;
  participant2RegId: number | null;
  nextMatchNumber: number | null;
  isThirdPlace: boolean;
  isFinal: boolean;
}

export class BracketService {
  static async generateBracket(eventId: number, userId: number) {
    const event = await db(t('events')).where('id', eventId).first();
    if (!event) throw AppError.notFound('Event');

    // Check if bracket already exists
    const existingBracket = await db(t('brackets')).where('event_id', eventId).first();
    if (existingBracket && existingBracket.status !== 'draft') {
      throw AppError.badRequest('Bracket has already been published');
    }

    // Get confirmed registrations with seeding
    const registrations = await db(t('registrations'))
      .where('event_id', eventId)
      .where('status', 'confirmed')
      .where('checked_in', true)
      .orderByRaw('seed_number IS NULL, seed_number ASC, created_at ASC');

    if (registrations.length < 2) {
      throw AppError.badRequest('Need at least 2 confirmed participants to generate bracket');
    }

    // Calculate bracket size (next power of 2)
    const bracketSize = this.nextPowerOf2(registrations.length);
    const totalRounds = Math.log2(bracketSize);
    const totalMatches = bracketSize - 1 + (event.has_third_place_match ? 1 : 0);

    // Seed participants into bracket positions
    const seededPositions = this.seedParticipants(registrations, bracketSize);

    // Generate match structure
    const matches = this.generateMatchStructure(
      bracketSize,
      totalRounds,
      seededPositions,
      event.has_third_place_match
    );

    const now = new Date();

    await db.transaction(async (trx) => {
      // Delete existing draft bracket if any
      if (existingBracket) {
        await trx(t('matches')).where('bracket_id', existingBracket.id).del();
        await trx(t('brackets')).where('id', existingBracket.id).del();
      }

      // Create bracket
      const [bracketId] = await trx(t('brackets')).insert({
        event_id: eventId,
        structure: JSON.stringify({
          size: bracketSize,
          total_rounds: totalRounds,
          has_third_place: event.has_third_place_match,
          participant_count: registrations.length,
          byes: bracketSize - registrations.length,
        }),
        total_rounds: totalRounds,
        status: 'draft',
        generated_at: now,
        created_at: now,
        updated_at: now,
      });

      // Create match records
      const matchInserts = [];
      const matchIdMap = new Map<number, number>();

      for (const match of matches) {
        const [matchId] = await trx(t('matches')).insert({
          uuid: uuidv4(),
          event_id: eventId,
          bracket_id: bracketId,
          round_number: match.round,
          match_number: match.matchNumber,
          round_name: match.roundName,
          participant_1_registration_id: match.participant1RegId,
          participant_2_registration_id: match.participant2RegId,
          is_third_place_match: match.isThirdPlace,
          is_final: match.isFinal,
          status: 'upcoming',
          created_at: now,
          updated_at: now,
        });
        matchIdMap.set(match.matchNumber, matchId);
      }

      // Update next_match_id references
      for (const match of matches) {
        if (match.nextMatchNumber !== null) {
          const currentMatchId = matchIdMap.get(match.matchNumber);
          const nextMatchId = matchIdMap.get(match.nextMatchNumber);
          if (currentMatchId && nextMatchId) {
            await trx(t('matches'))
              .where('id', currentMatchId)
              .update({ next_match_id: nextMatchId });
          }
        }
      }

      // Auto-advance byes (matches where one participant is null)
      for (const match of matches) {
        if (match.participant1RegId && !match.participant2RegId) {
          const matchId = matchIdMap.get(match.matchNumber);
          if (matchId) {
            await trx(t('matches')).where('id', matchId).update({
              winner_registration_id: match.participant1RegId,
              status: 'walkover',
              completed_at: now,
            });
          }
        } else if (!match.participant1RegId && match.participant2RegId) {
          const matchId = matchIdMap.get(match.matchNumber);
          if (matchId) {
            await trx(t('matches')).where('id', matchId).update({
              winner_registration_id: match.participant2RegId,
              status: 'walkover',
              completed_at: now,
            });
          }
        }
      }

      // Audit log
      await trx(t('audit_log')).insert({
        user_id: userId,
        action: 'bracket.generated',
        entity_type: 'bracket',
        entity_id: bracketId,
        new_values: JSON.stringify({
          size: bracketSize,
          rounds: totalRounds,
          matches: matches.length,
          participants: registrations.length,
        }),
        created_at: now,
      });
    });

    return this.getBracket(eventId);
  }

  /**
   * Generates a round-robin (league) schedule: every confirmed, checked-in
   * registration plays every other exactly once. Reuses the brackets +
   * matches tables — round-robin matches simply have no next_match_id and
   * never set is_final, so the existing scoring path (enterMatchResult,
   * ELO, achievements) works unchanged while tournament-completion logic
   * stays dormant.
   */
  static async generateRoundRobin(eventId: number, userId: number) {
    const event = await db(t('events')).where('id', eventId).first();
    if (!event) throw AppError.notFound('Event');

    const existingBracket = await db(t('brackets')).where('event_id', eventId).first();
    if (existingBracket && existingBracket.status !== 'draft') {
      throw AppError.badRequest('Bracket has already been published');
    }

    const registrations = await db(t('registrations'))
      .where('event_id', eventId)
      .where('status', 'confirmed')
      .where('checked_in', true)
      .orderByRaw('seed_number IS NULL, seed_number ASC, created_at ASC');

    if (registrations.length < 2) {
      throw AppError.badRequest('Need at least 2 confirmed participants to generate a round robin');
    }

    const pairings = generateRoundRobinPairings<number>(
      registrations.map((r: any) => r.id as number)
    );
    const totalRounds = pairings.reduce((max, p) => Math.max(max, p.round), 0);
    const now = new Date();

    await db.transaction(async (trx) => {
      if (existingBracket) {
        await trx(t('matches')).where('bracket_id', existingBracket.id).del();
        await trx(t('brackets')).where('id', existingBracket.id).del();
      }

      const [bracketId] = await trx(t('brackets')).insert({
        event_id: eventId,
        structure: JSON.stringify({
          type: 'round_robin',
          participant_count: registrations.length,
          total_rounds: totalRounds,
          total_matches: pairings.length,
        }),
        total_rounds: totalRounds,
        status: 'draft',
        generated_at: now,
        created_at: now,
        updated_at: now,
      });

      let matchNumber = 1;
      for (const pairing of pairings) {
        await trx(t('matches')).insert({
          uuid: uuidv4(),
          event_id: eventId,
          bracket_id: bracketId,
          round_number: pairing.round,
          match_number: matchNumber++,
          round_name: `Spieltag ${pairing.round}`,
          participant_1_registration_id: pairing.home,
          participant_2_registration_id: pairing.away,
          is_third_place_match: false,
          is_final: false,
          status: 'upcoming',
          created_at: now,
          updated_at: now,
        });
      }

      await trx(t('audit_log')).insert({
        user_id: userId,
        action: 'bracket.round_robin_generated',
        entity_type: 'bracket',
        entity_id: bracketId,
        new_values: JSON.stringify({
          rounds: totalRounds,
          matches: pairings.length,
          participants: registrations.length,
        }),
        created_at: now,
      });
    });

    return this.getBracket(eventId);
  }

  /**
   * League table for a round-robin event. 3 points per win; ties broken by
   * set difference, then sets won.
   */
  static async getStandings(eventId: number) {
    const bracket = await db(t('brackets')).where('event_id', eventId).first();
    if (!bracket) throw AppError.notFound('Bracket');

    const matches = await db(t('matches'))
      .where('bracket_id', bracket.id)
      .select(
        'id',
        'participant_1_registration_id',
        'participant_2_registration_id',
        'winner_registration_id',
        'status'
      );

    const scores = await db(t('match_scores')).whereIn(
      'match_id',
      matches.map((m: any) => m.id)
    );
    const scoresByMatch = new Map<number, any[]>();
    for (const s of scores) {
      if (!scoresByMatch.has(s.match_id)) scoresByMatch.set(s.match_id, []);
      scoresByMatch.get(s.match_id)!.push(s);
    }

    interface Row {
      registration_id: number;
      played: number;
      wins: number;
      losses: number;
      sets_won: number;
      sets_lost: number;
      points: number;
    }
    const rows = new Map<number, Row>();
    const ensure = (regId: number): Row => {
      if (!rows.has(regId)) {
        rows.set(regId, {
          registration_id: regId,
          played: 0,
          wins: 0,
          losses: 0,
          sets_won: 0,
          sets_lost: 0,
          points: 0,
        });
      }
      return rows.get(regId)!;
    };

    for (const m of matches) {
      if (m.participant_1_registration_id) ensure(m.participant_1_registration_id);
      if (m.participant_2_registration_id) ensure(m.participant_2_registration_id);
      if (m.status !== 'completed' || !m.winner_registration_id) continue;
      const p1 = m.participant_1_registration_id;
      const p2 = m.participant_2_registration_id;
      if (!p1 || !p2) continue;

      const r1 = ensure(p1);
      const r2 = ensure(p2);
      r1.played++;
      r2.played++;

      for (const set of scoresByMatch.get(m.id) ?? []) {
        if (set.participant_1_score > set.participant_2_score) {
          r1.sets_won++;
          r2.sets_lost++;
        } else if (set.participant_2_score > set.participant_1_score) {
          r2.sets_won++;
          r1.sets_lost++;
        }
      }

      const winner = m.winner_registration_id === p1 ? r1 : r2;
      const loser = winner === r1 ? r2 : r1;
      winner.wins++;
      winner.points += 3;
      loser.losses++;
    }

    // Resolve display names for each registration
    const regIds = [...rows.keys()];
    const names = regIds.length
      ? await db(`${t('registrations')} as r`)
          .leftJoin(`${t('profiles')} as p`, 'r.user_id', 'p.user_id')
          .whereIn('r.id', regIds)
          .select('r.id', 'p.display_name', 'p.first_name', 'p.last_name')
      : [];
    const nameOf = new Map<number, string>(
      names.map((n: any) => [
        n.id,
        n.display_name || [n.first_name, n.last_name].filter(Boolean).join(' ') || 'Spieler',
      ])
    );

    const table = [...rows.values()]
      .sort(
        (a, b) =>
          b.points - a.points ||
          b.sets_won - b.sets_lost - (a.sets_won - a.sets_lost) ||
          b.sets_won - a.sets_won
      )
      .map((row, idx) => ({
        rank: idx + 1,
        name: nameOf.get(row.registration_id) ?? 'Spieler',
        ...row,
        set_diff: row.sets_won - row.sets_lost,
      }));

    return {
      event_id: eventId,
      bracket_id: bracket.id,
      type: 'round_robin',
      standings: table,
    };
  }

  static async getBracket(eventId: number) {
    const bracket = await db(t('brackets')).where('event_id', eventId).first();
    if (!bracket) throw AppError.notFound('Bracket');

    const matches = await db(t('matches'))
      .where('bracket_id', bracket.id)
      .leftJoin(
        `${t('registrations')} as r1`,
        `${t('matches')}.participant_1_registration_id`,
        'r1.id'
      )
      .leftJoin(
        `${t('registrations')} as r2`,
        `${t('matches')}.participant_2_registration_id`,
        'r2.id'
      )
      .leftJoin(`${t('profiles')} as p1`, 'r1.user_id', 'p1.user_id')
      .leftJoin(`${t('profiles')} as p2`, 'r2.user_id', 'p2.user_id')
      .leftJoin(t('courts'), `${t('matches')}.court_id`, `${t('courts')}.id`)
      .leftJoin(t('match_scores'), `${t('matches')}.id`, `${t('match_scores')}.match_id`)
      .select(
        `${t('matches')}.*`,
        'p1.first_name as p1_first_name',
        'p1.last_name as p1_last_name',
        'p1.display_name as p1_display_name',
        'p2.first_name as p2_first_name',
        'p2.last_name as p2_last_name',
        'p2.display_name as p2_display_name',
        `${t('courts')}.name as court_name`
      )
      .orderBy('round_number', 'asc')
      .orderBy('match_number', 'asc');

    // Get scores for all matches
    const matchIds = matches.map((m: any) => m.id);
    const scores = await db(t('match_scores'))
      .whereIn('match_id', matchIds)
      .orderBy('set_number', 'asc');

    const scoreMap = new Map<number, any[]>();
    scores.forEach((s: any) => {
      if (!scoreMap.has(s.match_id)) scoreMap.set(s.match_id, []);
      scoreMap.get(s.match_id)!.push(s);
    });

    const composeName = (
      displayName: string | null | undefined,
      first: string | null | undefined,
      last: string | null | undefined
    ): string => {
      if (displayName) return displayName;
      const composed = [first, last].filter(Boolean).join(' ').trim();
      return composed || 'Spieler';
    };

    const enrichedMatches = matches.map((match: any) => ({
      id: match.id,
      uuid: match.uuid,
      round_number: match.round_number,
      match_number: match.match_number,
      round_name: match.round_name,
      court_name: match.court_name ?? null,
      // scheduled_at remains null until the match is scheduled — the
      // mobile client treats null as "TBD" and renders a placeholder.
      // We surface the null explicitly rather than silently coercing.
      scheduled_at: match.scheduled_at ?? null,
      is_third_place_match: match.is_third_place_match,
      is_final: match.is_final,
      status: match.status,
      participant_1: match.participant_1_registration_id ? {
        registration_id: match.participant_1_registration_id,
        name: composeName(match.p1_display_name, match.p1_first_name, match.p1_last_name),
      } : null,
      participant_2: match.participant_2_registration_id ? {
        registration_id: match.participant_2_registration_id,
        name: composeName(match.p2_display_name, match.p2_first_name, match.p2_last_name),
      } : null,
      winner_registration_id: match.winner_registration_id,
      scores: scoreMap.get(match.id) || [],
      started_at: match.started_at,
      completed_at: match.completed_at,
    }));

    return {
      id: bracket.id,
      event_id: bracket.event_id,
      structure: JSON.parse(bracket.structure),
      total_rounds: bracket.total_rounds,
      status: bracket.status,
      matches: enrichedMatches,
    };
  }

  /**
   * Compact, share-ready summary of a completed match — everything the
   * mobile app needs to render a social match card (players, score line,
   * event, venue, sponsor, ELO delta).
   */
  static async getMatchCard(matchId: number) {
    const match = await db(t('matches')).where('id', matchId).first();
    if (!match) throw AppError.notFound('Match');
    if (match.status !== 'completed' && match.status !== 'walkover') {
      throw AppError.badRequest('Match card is only available for completed matches');
    }

    const event = await db(t('events')).where('id', match.event_id).first();
    const venue = event?.venue_id
      ? await db(t('venues')).where('id', event.venue_id).first()
      : null;

    const sideInfo = async (regId: number | null) => {
      if (!regId) return null;
      const reg = await db(t('registrations')).where('id', regId).first();
      if (!reg) return null;
      const userIds = [reg.user_id, reg.partner_user_id].filter(
        (id: unknown): id is number => typeof id === 'number'
      );
      const profiles = await db(t('profiles'))
        .whereIn('user_id', userIds)
        .select('user_id', 'display_name', 'first_name', 'last_name', 'avatar_url');
      return {
        registration_id: regId,
        players: profiles.map((p: any) => ({
          user_id: p.user_id,
          name:
            p.display_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || 'Spieler',
          avatar_url: p.avatar_url ?? null,
        })),
      };
    };

    const [participant1, participant2] = await Promise.all([
      sideInfo(match.participant_1_registration_id),
      sideInfo(match.participant_2_registration_id),
    ]);

    const scores = await db(t('match_scores'))
      .where('match_id', matchId)
      .orderBy('set_number', 'asc')
      .select('set_number', 'participant_1_score', 'participant_2_score', 'is_tiebreak');

    // ELO delta of the winning side (recorded by EloService per player)
    const winnerUserIds = (
      match.winner_registration_id === match.participant_1_registration_id
        ? participant1
        : participant2
    )?.players.map((p) => p.user_id) ?? [];
    let eloDelta: number | null = null;
    if (winnerUserIds.length) {
      const history = await db(t('rating_history'))
        .where('match_id', matchId)
        .whereIn('user_id', winnerUserIds)
        .first('delta');
      eloDelta = history ? Number(history.delta) : null;
    }

    return {
      match_id: match.id,
      uuid: match.uuid,
      round_name: match.round_name,
      is_final: Boolean(match.is_final),
      completed_at: match.completed_at,
      winner_registration_id: match.winner_registration_id,
      participant_1: participant1,
      participant_2: participant2,
      sets: scores.map((s: any) => ({
        set: s.set_number,
        p1: s.participant_1_score,
        p2: s.participant_2_score,
        tiebreak: Boolean(s.is_tiebreak),
      })),
      elo_delta: eloDelta,
      event: event
        ? {
            id: event.id,
            title: event.title,
            sport_category: event.sport_category,
            sponsor_name: event.sponsor_name ?? null,
            sponsor_logo_url: event.sponsor_logo_url ?? null,
          }
        : null,
      venue: venue ? { id: venue.id, name: venue.name, city: venue.address_city } : null,
    };
  }

  static async enterMatchResult(
    matchId: number,
    scores: Array<{ set_number: number; p1_score: number; p2_score: number; is_tiebreak?: boolean }>,
    winnerId: number,
    userId: number
  ) {
    const match = await db(t('matches')).where('id', matchId).first();
    if (!match) throw AppError.notFound('Match');

    if (match.status === 'completed') {
      throw AppError.badRequest('Match result has already been entered');
    }

    // Validate winner is one of the participants
    if (winnerId !== match.participant_1_registration_id && winnerId !== match.participant_2_registration_id) {
      throw AppError.badRequest('Winner must be one of the match participants');
    }

    const now = new Date();

    await db.transaction(async (trx) => {
      // Insert scores
      for (const score of scores) {
        await trx(t('match_scores'))
          .insert({
            match_id: matchId,
            set_number: score.set_number,
            participant_1_score: score.p1_score,
            participant_2_score: score.p2_score,
            is_tiebreak: score.is_tiebreak || false,
          })
          .onConflict(['match_id', 'set_number'])
          .merge();
      }

      // Update match
      await trx(t('matches')).where('id', matchId).update({
        winner_registration_id: winnerId,
        status: 'completed',
        completed_at: now,
        updated_at: now,
      });

      // Advance winner to next match
      if (match.next_match_id) {
        const nextMatch = await trx(t('matches')).where('id', match.next_match_id).first();
        if (nextMatch) {
          if (!nextMatch.participant_1_registration_id) {
            await trx(t('matches')).where('id', match.next_match_id).update({
              participant_1_registration_id: winnerId,
              updated_at: now,
            });
          } else if (!nextMatch.participant_2_registration_id) {
            await trx(t('matches')).where('id', match.next_match_id).update({
              participant_2_registration_id: winnerId,
              updated_at: now,
            });
          }
        }
      }

      // Handle third place match - advance loser to 3rd place match
      if (match.round_name === 'Semifinal' || match.round_name === 'Halbfinale') {
        const loserId = winnerId === match.participant_1_registration_id
          ? match.participant_2_registration_id
          : match.participant_1_registration_id;

        const thirdPlaceMatch = await trx(t('matches'))
          .where('event_id', match.event_id)
          .where('is_third_place_match', true)
          .first();

        if (thirdPlaceMatch && loserId) {
          if (!thirdPlaceMatch.participant_1_registration_id) {
            await trx(t('matches')).where('id', thirdPlaceMatch.id).update({
              participant_1_registration_id: loserId,
              updated_at: now,
            });
          } else if (!thirdPlaceMatch.participant_2_registration_id) {
            await trx(t('matches')).where('id', thirdPlaceMatch.id).update({
              participant_2_registration_id: loserId,
              updated_at: now,
            });
          }
        }
      }

      // Notify participants
      const participant1 = await trx(t('registrations')).where('id', match.participant_1_registration_id).first();
      const participant2 = await trx(t('registrations')).where('id', match.participant_2_registration_id).first();

      const notifyUsers = [participant1?.user_id, participant2?.user_id].filter(Boolean);
      for (const notifyUserId of notifyUsers) {
        await trx(t('notifications')).insert({
          user_id: notifyUserId,
          type: 'result_entered',
          title: 'Ergebnis eingetragen',
          body: 'Das Ergebnis deines Matches wurde eingetragen.',
          data: JSON.stringify({ match_id: matchId, event_id: match.event_id }),
          created_at: now,
        });
      }

      // Audit log
      await trx(t('audit_log')).insert({
        user_id: userId,
        action: 'match.result_entered',
        entity_type: 'match',
        entity_id: matchId,
        new_values: JSON.stringify({ winner_id: winnerId, scores }),
        created_at: now,
      });
    });

    // Live update for everyone watching this bracket (best-effort,
    // in-process WebSocket hub).
    try {
      const { broadcastBracketUpdate } = await import('../realtime/liveBracket');
      broadcastBracketUpdate(match.event_id);
    } catch (err) {
      console.warn('[brackets] live broadcast failed:', err);
    }

    // Post-result hooks: ELO, achievements, finals → tournament completion
    try {
      const event = await db(t('events')).where('id', match.event_id).first();
      const sport = event?.sport_category === 'fifa' ? 'fifa' : 'padel';
      if (sport === 'padel' || sport === 'fifa') {
        const eloResult = await EloService.updateAfterMatch(matchId, sport);
        // Rival push: tell overtaken friends they just lost their spot.
        if (eloResult) {
          try {
            const { RivalService } = await import('./rivalService');
            await RivalService.notifyOvertakenRivals(
              eloResult.winner.userId,
              sport,
              eloResult.winner.oldElo,
              eloResult.winner.newElo
            );
          } catch (err) {
            console.warn('[brackets] rival notification failed:', err);
          }
        }
      }

      // Weekly play-streaks for everyone on court (winner + loser side)
      try {
        const loserRegId =
          winnerId === match.participant_1_registration_id
            ? match.participant_2_registration_id
            : match.participant_1_registration_id;
        const regs = await db(t('registrations'))
          .whereIn('id', [winnerId, loserRegId].filter(Boolean))
          .select('user_id', 'partner_user_id');
        const allPlayers = regs.flatMap((r: any) =>
          [r.user_id, r.partner_user_id].filter((id: unknown): id is number => typeof id === 'number')
        );
        const { StreakService } = await import('./streakService');
        await StreakService.recordPlayed(allPlayers);
      } catch (err) {
        console.warn('[brackets] streak update failed:', err);
      }

      // Achievement evaluation for the winning side
      const winnerReg = await db(t('registrations')).where('id', winnerId).first();
      const winnerUserIds = [winnerReg?.user_id, winnerReg?.partner_user_id].filter(Boolean) as number[];
      for (const uid of winnerUserIds) {
        await AchievementService.evaluateAfterMatchWin(uid, matchId);
        await AchievementService.evaluateVeteran(uid);
      }

      // Tournament completion (final match concluded)
      const refreshed = await db(t('matches')).where('id', matchId).first();
      if (refreshed?.is_final) {
        await this.completeTournament(match.event_id, winnerId);
      }
    } catch (err) {
      console.error('[brackets] post-result hook failed:', err);
    }

    return this.getBracket(match.event_id);
  }

  /**
   * Player-facing score entry. Auto-determines the winner from set wins,
   * authorises the caller against the match participants, and delegates to
   * `enterMatchResult` (which also runs ELO + achievement hooks).
   */
  static async enterScoresAsPlayer(
    matchId: number,
    sets: Array<{ set_number: number; p1_score: number; p2_score: number; is_tiebreak?: boolean }>,
    userId: number
  ) {
    const match = await db(t('matches')).where('id', matchId).first();
    if (!match) throw AppError.notFound('Match');
    if (match.status === 'completed') {
      throw AppError.badRequest('Match result has already been entered');
    }

    // Authorise: admin OR a participant of the match
    const user = await db(t('users')).where('id', userId).first();
    const isAdmin = user && (user.role === 'admin' || user.role === 'superadmin');
    if (!isAdmin) {
      const allowed = await this.isParticipant(match, userId);
      if (!allowed) throw AppError.forbidden('Only participants or admins can score this match');
    }

    if (!Array.isArray(sets) || sets.length === 0) {
      throw AppError.badRequest('At least one set is required');
    }

    let p1Wins = 0;
    let p2Wins = 0;
    for (const s of sets) {
      if (s.p1_score > s.p2_score) p1Wins++;
      else if (s.p2_score > s.p1_score) p2Wins++;
    }
    if (p1Wins === p2Wins) {
      throw AppError.badRequest('Cannot determine winner — sets are tied');
    }
    const winnerRegId = p1Wins > p2Wins
      ? match.participant_1_registration_id
      : match.participant_2_registration_id;

    return this.enterMatchResult(matchId, sets, winnerRegId, userId);
  }

  /**
   * Returns the next upcoming match for a user (across all events).
   * Used by GET /api/me/next-match for the home-screen alert banner.
   */
  static async getNextMatchForUser(userId: number) {
    const now = new Date();
    const row = await db(t('matches') + ' as m')
      .join(t('registrations') + ' as r', function () {
        this.on('r.id', '=', 'm.participant_1_registration_id').orOn(
          'r.id',
          '=',
          'm.participant_2_registration_id'
        );
      })
      .leftJoin(t('events') + ' as e', 'e.id', 'm.event_id')
      .leftJoin(t('courts') + ' as c', 'c.id', 'm.court_id')
      .where(function () {
        this.where('r.user_id', userId).orWhere('r.partner_user_id', userId);
      })
      .where('m.status', 'upcoming')
      .where('m.scheduled_at', '>=', now)
      .orderBy('m.scheduled_at', 'asc')
      .first(
        'm.id as match_id',
        'm.uuid as match_uuid',
        'm.scheduled_at',
        'm.round_name',
        'm.event_id',
        'e.title as event_title',
        'c.name as court_name'
      );
    return row || null;
  }

  /**
   * Returns the waitlist position info for a registration.
   */
  static async getWaitlistStatus(registrationId: number) {
    const reg = await db(t('registrations')).where('id', registrationId).first();
    if (!reg) throw AppError.notFound('Registration');
    if (reg.status !== 'waitlisted') {
      return {
        position: 0,
        total_waitlisted: 0,
        ahead_of_you: 0,
        estimated_chance: 'none' as const,
      };
    }
    const all = await db(t('registrations'))
      .where({ event_id: reg.event_id, status: 'waitlisted' })
      .orderByRaw('waitlist_position IS NULL, waitlist_position ASC, created_at ASC')
      .select('id', 'waitlist_position');
    const idx = all.findIndex((r: any) => r.id === reg.id);
    const position = idx >= 0 ? idx + 1 : all.length;
    const total = all.length;
    let chance: 'high' | 'medium' | 'low' = 'low';
    if (position <= 2) chance = 'high';
    else if (position <= 5) chance = 'medium';
    return {
      position,
      total_waitlisted: total,
      ahead_of_you: Math.max(0, position - 1),
      estimated_chance: chance,
    };
  }

  /**
   * Internal — checks if a user is one of the registrations of a match.
   */
  private static async isParticipant(match: any, userId: number): Promise<boolean> {
    const regIds = [
      match.participant_1_registration_id,
      match.participant_2_registration_id,
    ].filter(Boolean);
    if (!regIds.length) return false;
    const row = await db(t('registrations'))
      .whereIn('id', regIds)
      .andWhere(function () {
        this.where('user_id', userId).orWhere('partner_user_id', userId);
      })
      .first();
    return !!row;
  }

  /**
   * Marks the event completed, sets final_placement on podium registrations,
   * fires the winner push notification.
   */
  private static async completeTournament(eventId: number, finalWinnerRegId: number) {
    const now = new Date();
    const event = await db(t('events')).where('id', eventId).first();
    if (!event) return;

    // Determine 1st/2nd from final, 3rd from third-place match (if any)
    const finalMatch = await db(t('matches'))
      .where({ event_id: eventId, is_final: true })
      .first();
    const thirdMatch = await db(t('matches'))
      .where({ event_id: eventId, is_third_place_match: true })
      .first();

    if (finalMatch?.winner_registration_id) {
      const loserId =
        finalMatch.winner_registration_id === finalMatch.participant_1_registration_id
          ? finalMatch.participant_2_registration_id
          : finalMatch.participant_1_registration_id;
      await db(t('registrations')).where('id', finalMatch.winner_registration_id).update({
        final_placement: 1,
        updated_at: now,
      });
      if (loserId) {
        await db(t('registrations')).where('id', loserId).update({
          final_placement: 2,
          updated_at: now,
        });
      }
    }
    if (thirdMatch?.winner_registration_id) {
      await db(t('registrations')).where('id', thirdMatch.winner_registration_id).update({
        final_placement: 3,
        updated_at: now,
      });
    }

    await db(t('events')).where('id', eventId).update({
      status: 'completed',
      updated_at: now,
    });

    // Push to winner(s)
    const winnerReg = await db(t('registrations')).where('id', finalWinnerRegId).first();
    const winnerUserIds = [winnerReg?.user_id, winnerReg?.partner_user_id].filter(Boolean) as number[];
    for (const uid of winnerUserIds) {
      await NotificationService.send(
        uid,
        'tournament_completed',
        'Glückwunsch! 🏆',
        `Du hast "${event.title}" gewonnen! Teile deinen Sieg mit der Community.`,
        { event_id: eventId }
      );
      // Evaluate first_prize achievement for the winner
      try {
        await AchievementService.evaluateAfterPrize(uid);
      } catch (err) {
        console.warn('[bracket] evaluateAfterPrize failed:', err);
      }
    }
  }

  // --- Helper Methods ---

  private static nextPowerOf2(n: number): number {
    let power = 1;
    while (power < n) power *= 2;
    return power;
  }

  private static seedParticipants(
    registrations: any[],
    bracketSize: number
  ): (number | null)[] {
    const positions: (number | null)[] = new Array(bracketSize).fill(null);

    // Standard seeding positions for power-of-2 brackets
    const seedOrder = this.generateSeedOrder(bracketSize);

    for (let i = 0; i < registrations.length; i++) {
      positions[seedOrder[i]] = registrations[i].id;
    }

    return positions;
  }

  private static generateSeedOrder(size: number): number[] {
    if (size === 1) return [0];
    if (size === 2) return [0, 1];

    const result: number[] = [];
    const recurse = (start: number, end: number, seeds: number[]) => {
      if (seeds.length === 0) return;
      if (seeds.length === 1) {
        result[seeds[0] - 1] = start;
        return;
      }

      const mid = Math.floor((start + end) / 2);
      const top: number[] = [];
      const bottom: number[] = [];

      for (let i = 0; i < seeds.length; i++) {
        if (i % 2 === 0) top.push(seeds[i]);
        else bottom.push(seeds[i]);
      }

      recurse(start, mid, top);
      recurse(mid, end, bottom);
    };

    const seeds = Array.from({ length: size }, (_, i) => i + 1);
    recurse(0, size, seeds);

    return result;
  }

  private static generateMatchStructure(
    bracketSize: number,
    totalRounds: number,
    seededPositions: (number | null)[],
    hasThirdPlace: boolean
  ): BracketMatch[] {
    const matches: BracketMatch[] = [];
    let matchNumber = 1;

    const roundNames: Record<number, string> = {};
    roundNames[totalRounds] = 'Finale';
    if (totalRounds >= 2) roundNames[totalRounds - 1] = 'Halbfinale';
    if (totalRounds >= 3) roundNames[totalRounds - 2] = 'Viertelfinale';
    if (totalRounds >= 4) roundNames[totalRounds - 3] = 'Achtelfinale';
    if (totalRounds >= 5) roundNames[totalRounds - 4] = 'Sechzehntelfinale';

    // Generate round 1 matches
    for (let i = 0; i < bracketSize; i += 2) {
      const currentMatchNumber = matchNumber++;
      const nextRoundMatch = Math.ceil(currentMatchNumber / 2) + bracketSize / 2;

      matches.push({
        round: 1,
        matchNumber: currentMatchNumber,
        roundName: roundNames[1] || `Runde 1`,
        participant1RegId: seededPositions[i],
        participant2RegId: seededPositions[i + 1],
        nextMatchNumber: totalRounds > 1 ? nextRoundMatch : null,
        isThirdPlace: false,
        isFinal: totalRounds === 1,
      });
    }

    // Generate subsequent rounds
    let matchesInRound = bracketSize / 4;
    for (let round = 2; round <= totalRounds; round++) {
      const firstMatchInRound = matchNumber;
      for (let i = 0; i < matchesInRound; i++) {
        const currentMatchNumber = matchNumber++;
        const nextRoundMatch = round < totalRounds
          ? Math.ceil((currentMatchNumber - firstMatchInRound + 1) / 2) + matchNumber + matchesInRound - (currentMatchNumber - firstMatchInRound + 1)
          : null;

        matches.push({
          round,
          matchNumber: currentMatchNumber,
          roundName: roundNames[round] || `Runde ${round}`,
          participant1RegId: null,
          participant2RegId: null,
          nextMatchNumber: round < totalRounds ? firstMatchInRound + matchesInRound + Math.floor(i / 2) : null,
          isThirdPlace: false,
          isFinal: round === totalRounds,
        });
      }
      matchesInRound = Math.max(1, matchesInRound / 2);
    }

    // Third place match
    if (hasThirdPlace && totalRounds >= 2) {
      matches.push({
        round: totalRounds,
        matchNumber: matchNumber++,
        roundName: 'Spiel um Platz 3',
        participant1RegId: null,
        participant2RegId: null,
        nextMatchNumber: null,
        isThirdPlace: true,
        isFinal: false,
      });
    }

    return matches;
  }
}