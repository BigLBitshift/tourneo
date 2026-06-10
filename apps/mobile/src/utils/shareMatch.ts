import { Share } from 'react-native';
import { deepLinks } from './deepLinks';
import { getMatchCard, type MatchCard } from '../api/v2';

/**
 * shareMatchResult — emits a formatted share sheet with a rich text snippet
 * describing a completed match. Consumers pass the relevant details; the
 * format adapts to available fields (score, winner, venue, delta).
 */
export interface ShareMatchPayload {
  winnerName: string;
  loserName: string;
  sets?: Array<{ p1: number; p2: number }>;
  eventTitle?: string;
  venueName?: string;
  sport?: 'padel' | 'fifa';
  eloDelta?: number;
  matchUrl?: string;
}

export async function shareMatchResult(p: ShareMatchPayload): Promise<boolean> {
  const sportIcon = p.sport === 'fifa' ? '🎮' : '🏸';
  const scoreLine = p.sets?.length
    ? p.sets.map((s) => `${s.p1}-${s.p2}`).join(' · ')
    : '';
  const deltaLine = p.eloDelta ? `ELO ${p.eloDelta > 0 ? '+' : ''}${p.eloDelta}` : '';

  const lines = [
    `${sportIcon} ${p.winnerName} schlägt ${p.loserName}`,
    scoreLine,
    p.eventTitle ?? '',
    p.venueName ? `📍 ${p.venueName}` : '',
    deltaLine,
    p.matchUrl ?? '',
    '#tourneo',
  ].filter(Boolean);

  try {
    await Share.share({
      message: lines.join('\n'),
      url: p.matchUrl,
      title: `${p.winnerName} vs ${p.loserName}`,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * shareMatchById — convenience wrapper that pulls the server-rendered
 * match card and turns it into a share payload. Used by the result
 * screens so callers don't have to assemble names / score / venue / ELO
 * delta themselves.
 *
 * Returns false if the match doesn't have a card yet (e.g. still in
 * progress), so the UI can hide or disable its share button.
 */
export async function shareMatchById(matchId: number): Promise<boolean> {
  let card: MatchCard;
  try {
    card = await getMatchCard(matchId);
  } catch {
    return false;
  }

  const winnerSide =
    card.winner_registration_id === card.participant_1?.registration_id
      ? card.participant_1
      : card.participant_2;
  const loserSide =
    card.winner_registration_id === card.participant_1?.registration_id
      ? card.participant_2
      : card.participant_1;
  if (!winnerSide || !loserSide) return false;

  return shareMatchResult({
    winnerName: winnerSide.players.map((p) => p.name).join(' & '),
    loserName: loserSide.players.map((p) => p.name).join(' & '),
    sets: card.sets.map((s) => ({ p1: s.p1, p2: s.p2 })),
    eventTitle: card.event?.title,
    venueName: card.venue?.name,
    sport: card.event?.sport_category === 'fifa' ? 'fifa' : 'padel',
    eloDelta: card.elo_delta ?? undefined,
    matchUrl: deepLinks.match(card.match_id),
  });
}

/**
 * shareTournamentInvite — share a deep-link to join a tournament.
 */
export async function shareTournamentInvite(eventId: number, title: string, startDate?: string): Promise<boolean> {
  const url = deepLinks.event(eventId);
  const lines = [
    `🏆 Komm zu ${title}!`,
    startDate ? `📅 ${new Date(startDate).toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short' })}` : '',
    'Melde dich jetzt auf Tourneo an:',
    url,
  ].filter(Boolean);

  try {
    await Share.share({
      message: lines.join('\n'),
      url,
      title,
    });
    return true;
  } catch {
    return false;
  }
}
