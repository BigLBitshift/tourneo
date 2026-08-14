/**
 * V2 API wrappers — live score, ELO, partners, chat, recap, ical,
 * venue reviews & photos, referrals, achievements, waitlist.
 *
 * Thin, typed thin shells over apiClient. Screens can call these
 * directly; stores can wrap them if they need caching.
 */
import apiClient, { API_BASE_URL } from './client';

// ─── Shared types ─────────────────────────────────────────
export type MatchSet = { p1: number; p2: number };
export type EloTier =
  | 'bronze'
  | 'silver'
  | 'gold'
  | 'platinum'
  | 'diamond'
  | 'elite';

// ─── Live-score referee ───────────────────────────────────
export async function postMatchScore(matchId: number, sets: MatchSet[]) {
  const res = await apiClient.post(`/matches/${matchId}/score`, { sets });
  return res.data.data;
}
export async function getMatchScore(matchId: number) {
  const res = await apiClient.get(`/matches/${matchId}/score`);
  return res.data.data;
}
export async function getMyNextMatch() {
  const res = await apiClient.get(`/matches/me/next`);
  return res.data.data;
}

// ─── Recap + ical ─────────────────────────────────────────
export async function getEventRecap(eventId: number) {
  const res = await apiClient.get(`/events/${eventId}/recap`);
  return res.data.data;
}
export function getEventIcalUrl(eventId: number) {
  return `${API_BASE_URL}/events/${eventId}/ical`;
}

// ─── Partner search ───────────────────────────────────────
export async function listPartners(eventId: number) {
  const res = await apiClient.get(`/events/${eventId}/partners`);
  return res.data.data as Array<{
    id: number;
    user_id: number;
    display_name: string;
    avatar_url: string | null;
    message?: string;
    skill_level?: string;
    status: string;
    created_at: string;
  }>;
}
export async function createPartnerRequest(
  eventId: number,
  body: { message?: string; skill_level?: 'beginner' | 'intermediate' | 'advanced' | 'open' }
) {
  const res = await apiClient.post(`/events/${eventId}/partners`, body);
  return res.data.data;
}
export async function deletePartnerRequest(id: number) {
  const res = await apiClient.delete(`/partners/${id}`);
  return res.data.data;
}
export async function contactPartner(id: number) {
  const res = await apiClient.post(`/partners/${id}/contact`, {});
  return res.data.data;
}

// ─── Chat ────────────────────────────────────────────────
export async function listChat(eventId: number) {
  const res = await apiClient.get(`/events/${eventId}/chat`);
  return res.data.data as Array<{
    id: number;
    user_id: number;
    display_name: string;
    avatar_url: string | null;
    message: string;
    created_at: string;
  }>;
}
export async function postChat(eventId: number, message: string) {
  const res = await apiClient.post(`/events/${eventId}/chat`, { message });
  return res.data.data;
}

// ─── Waitlist position ────────────────────────────────────
export async function getWaitlistStatus(registrationId: number) {
  const res = await apiClient.get(
    `/registrations/${registrationId}/waitlist-status`
  );
  return res.data.data as {
    registration_id: number;
    position: number | null;
    total_waitlisted: number;
    ahead_of_you: number;
    estimated_chance: 'high' | 'medium' | 'low' | 'unknown';
  };
}

// ─── ELO / achievements / referrals ───────────────────────
export async function getMyElo() {
  const res = await apiClient.get('/me/elo');
  return res.data.data as {
    padel: { elo: number; peak: number; tier: EloTier };
    fifa: { elo: number; peak: number; tier: EloTier };
    matches_played: number;
  };
}
export async function getMyAchievements() {
  const res = await apiClient.get('/me/achievements');
  return res.data.data as Array<{
    id: number;
    achievement_type: string;
    earned_at: string;
  }>;
}
export async function getMyReferral() {
  const res = await apiClient.get('/me/referral');
  return res.data.data as { total: number; rewarded: number; code: string };
}
export async function createMyReferralCode() {
  const res = await apiClient.post('/me/referral/code', {});
  return res.data.data as { code: string };
}

// ─── Venue reviews & photos ───────────────────────────────
export async function listVenueReviews(venueId: number) {
  const res = await apiClient.get(`/venues/${venueId}/reviews`);
  return {
    reviews: res.data.data as Array<{
      id: number;
      user_id: number;
      display_name: string;
      avatar_url: string | null;
      rating: number;
      comment: string | null;
      created_at: string;
    }>,
    summary: res.data.meta as { average: number; count: number },
  };
}
export async function postVenueReview(
  venueId: number,
  rating: number,
  comment?: string
) {
  const res = await apiClient.post(`/venues/${venueId}/reviews`, {
    rating,
    comment,
  });
  return res.data.data;
}
export async function listVenuePhotos(venueId: number) {
  const res = await apiClient.get(`/venues/${venueId}/photos`);
  return res.data.data as Array<{
    id: number;
    image_url: string;
    created_at: string;
  }>;
}
export async function uploadVenuePhoto(venueId: number, uri: string) {
  const form = new FormData();
  // @ts-ignore — RN FormData accepts this shape
  form.append('image', {
    uri,
    name: 'photo.jpg',
    type: 'image/jpeg',
  });
  const res = await apiClient.post(`/venues/${venueId}/photos`, form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return res.data.data;
}

// ─── Playtomic level & verification ──────────────────────
export type PlaytomicStatus = {
  level: number | null;
  status: 'none' | 'pending' | 'approved' | 'rejected';
  source: 'default' | 'playtomic_self' | 'playtomic_verified';
  screenshotUrl: string | null;
};

export async function getMyPlaytomic(): Promise<PlaytomicStatus> {
  const res = await apiClient.get('/me/playtomic');
  return res.data.data;
}

export async function declarePlaytomicLevel(level: number) {
  const res = await apiClient.post('/me/playtomic/declare', { level });
  return res.data.data as { seedElo: number; status: string };
}

export async function submitPlaytomicScreenshot(screenshotUrl: string) {
  const res = await apiClient.post('/me/playtomic/screenshot', {
    screenshot_url: screenshotUrl,
  });
  return res.data.data;
}

// ─── Match feedback (rating calibration) ─────────────────
export type MatchFeedbackValue = 'lower' | 'correct' | 'higher';

export async function listPendingFeedback() {
  const res = await apiClient.get('/me/feedback/pending');
  return res.data.data as Array<{
    id: number;
    event_id: number;
    participant_1_registration_id: number;
    participant_2_registration_id: number;
    completed_at: string;
  }>;
}

export async function submitMatchFeedback(
  matchId: number,
  opponentUserId: number,
  feedback: MatchFeedbackValue,
  comment?: string
) {
  const res = await apiClient.post('/me/feedback', {
    match_id: matchId,
    opponent_user_id: opponentUserId,
    feedback,
    comment,
  });
  return res.data.data;
}

// ─── Rating history (ELO chart) ──────────────────────────
export type RatingHistoryPoint = {
  id: number;
  user_id: number;
  sport: 'padel' | 'fifa';
  elo: number;
  delta: number;
  match_id: number | null;
  reason: 'match' | 'calibration' | 'seed' | 'admin';
  recorded_at: string;
};

export async function getMyEloHistory(
  sport: 'padel' | 'fifa' = 'padel',
  limit: number = 30,
): Promise<RatingHistoryPoint[]> {
  const res = await apiClient.get('/me/elo/history', {
    params: { sport, limit },
  });
  return res.data.data;
}

// ─── Player discovery / matchmaking ──────────────────────
export type DiscoverablePlayer = {
  user_id: number;
  display_name: string;
  avatar_url: string | null;
  city: string | null;
  elo: number;
  tier: EloTier;
  matches_played: number;
  last_active_at: string | null;
  distance_km: number | null;
};

export async function searchPlayers(opts: {
  sport: 'padel' | 'fifa';
  elo_min?: number;
  elo_max?: number;
  city?: string;
  lat?: number;
  lng?: number;
  radius_km?: number;
  limit?: number;
}): Promise<DiscoverablePlayer[]> {
  const res = await apiClient.get('/players/search', { params: opts });
  return res.data.data;
}

export async function setDiscoverable(discoverable: boolean) {
  const res = await apiClient.put('/me/discoverable', { discoverable });
  return res.data.data as { discoverable: boolean };
}

export async function sendHeartbeat() {
  const res = await apiClient.post('/me/heartbeat', {});
  return res.data.data as { ok: boolean };
}

// ─── Public player profile ───────────────────────────────
export type PlayerStats = {
  matches_played: number;
  matches_won: number;
  matches_lost: number;
  win_rate: number;
  current_streak: number;
  streak_type: 'win' | 'loss' | 'none';
  last_5: Array<'W' | 'L'>;
};

export type PublicPlayerProfile = {
  user_id: number;
  display_name: string;
  avatar_url: string | null;
  city: string | null;
  bio: string | null;
  member_since: string;
  discoverable: boolean;
  last_active_at: string | null;
  padel: { elo: number; peak: number; tier: EloTier };
  fifa: { elo: number; peak: number; tier: EloTier };
  stats: PlayerStats;
  achievements_count: number;
  tournaments_played: number;
};

export type HeadToHead = {
  opponent_user_id: number;
  opponent_name: string;
  opponent_avatar: string | null;
  total_matches: number;
  my_wins: number;
  opponent_wins: number;
  recent_matches: Array<{
    match_id: number;
    event_title: string;
    completed_at: string;
    won: boolean;
  }>;
};

export async function getPublicProfile(userId: number): Promise<PublicPlayerProfile> {
  const res = await apiClient.get(`/profiles/${userId}`);
  return res.data.data;
}

export async function getHeadToHead(userId: number): Promise<HeadToHead> {
  const res = await apiClient.get(`/profiles/${userId}/head-to-head`);
  return res.data.data;
}

export async function getPlayerEloHistory(
  userId: number,
  sport: 'padel' | 'fifa' = 'padel',
  limit: number = 30,
): Promise<RatingHistoryPoint[]> {
  const res = await apiClient.get(`/profiles/${userId}/elo-history`, {
    params: { sport, limit },
  });
  return res.data.data;
}

// ─── Court availability ──────────────────────────────────
export type SlotStatus = 'available' | 'held' | 'booked' | 'blocked';

/**
 * Where the slot information came from. `venue` and `import` are club-
 * confirmed and bookable; `assumed` and `crowd` are shown as "probably
 * free — ask the club" so coverage can grow without the app claiming more
 * certainty than it has.
 */
export type SlotSource = 'venue' | 'import' | 'assumed' | 'crowd' | 'admin';

export type AvailabilitySlot = {
  id: number;
  venue_id: number;
  court_id: number | null;
  slot_date: string;
  slot_start: string;
  slot_end: string;
  starts_at_utc?: string | null;
  ends_at_utc?: string | null;
  status: SlotStatus;
  source?: SlotSource;
  confidence?: number;
  price_cents: number | null;
  booking_url: string | null;
  queue_length?: number;
};

export async function getVenueAvailability(
  venueId: number,
  opts: { from?: string; to?: string; courtId?: number } = {}
): Promise<AvailabilitySlot[]> {
  const params: Record<string, string | number> = {};
  if (opts.from) params.from = opts.from;
  if (opts.to) params.to = opts.to;
  if (opts.courtId) params.court_id = opts.courtId;
  const res = await apiClient.get(`/venues/${venueId}/availability`, { params });
  return res.data.data;
}

// ─── Court bookings (in-app) ─────────────────────────────
export type CourtBooking = {
  id: number;
  uuid: string;
  slot_id: number;
  venue_id: number;
  court_id: number | null;
  user_id: number;
  status: 'pending_payment' | 'confirmed' | 'cancelled';
  price_cents: number | null;
  currency: string;
  payment_method: 'pay_at_venue' | 'card' | 'membership' | 'other';
  notes: string | null;
  booked_at: string;
  cancelled_at: string | null;
  slot_date: string;
  slot_start: string;
  slot_end: string;
  venue_name: string | null;
  venue_street: string | null;
  venue_city: string | null;
  court_name: string | null;
  /**
   * Present when the venue is Stripe-Connect-enabled and the slot is
   * priced: the booking starts as pending_payment and this secret
   * confirms the PaymentIntent. Null for pay-at-venue bookings.
   */
  client_secret?: string | null;
};

export async function bookSlot(slotId: number, notes?: string): Promise<CourtBooking> {
  const res = await apiClient.post('/bookings', { slot_id: slotId, notes });
  return res.data.data;
}

export async function listMyBookings(opts: { upcomingOnly?: boolean } = {}): Promise<CourtBooking[]> {
  const params: Record<string, string> = {};
  if (opts.upcomingOnly) params.upcoming = 'true';
  const res = await apiClient.get('/bookings', { params });
  return res.data.data;
}

export async function cancelBooking(bookingId: number): Promise<{ id: number; status: 'cancelled' }> {
  const res = await apiClient.delete(`/bookings/${bookingId}`);
  return res.data.data;
}

// ─── Leaderboard (city / global) ─────────────────────────
export type LeaderboardCityEntry = {
  rank: number;
  user_id: number;
  name: string;
  avatar_url: string | null;
  city: string | null;
  elo: number;
  tier: EloTier;
  matches_played: number;
};

export async function getCityLeaderboard(opts: {
  sport: 'padel' | 'fifa';
  city?: string;
  limit?: number;
}): Promise<{
  sport: 'padel' | 'fifa';
  city: string | null;
  entries: LeaderboardCityEntry[];
  my_rank: number | null;
}> {
  const res = await apiClient.get('/leaderboard', { params: opts });
  return res.data.data;
}

// ─── Round-robin standings ───────────────────────────────
export type StandingsRow = {
  rank: number;
  registration_id: number;
  name: string;
  played: number;
  wins: number;
  losses: number;
  sets_won: number;
  sets_lost: number;
  set_diff: number;
  points: number;
};

export async function getEventStandings(eventId: number): Promise<{
  event_id: number;
  bracket_id: number;
  type: 'round_robin';
  standings: StandingsRow[];
}> {
  const res = await apiClient.get(`/matches/events/${eventId}/standings`);
  return res.data.data;
}

// ─── Americano ───────────────────────────────────────────
export type AmericanoPlayer = { user_id: number; name: string; avatar_url: string | null };
export type AmericanoMatchView = {
  id: number;
  round_number: number;
  court_number: number;
  team_a: AmericanoPlayer[];
  team_b: AmericanoPlayer[];
  score_a: number | null;
  score_b: number | null;
  status: 'upcoming' | 'completed';
};
export type AmericanoSession = {
  id: number;
  event_id: number;
  status: 'draft' | 'in_progress' | 'completed';
  courts_count: number;
  rounds_count: number;
  points_per_match: number;
  matches: AmericanoMatchView[];
};

export async function getAmericanoSession(eventId: number): Promise<AmericanoSession | null> {
  try {
    const res = await apiClient.get(`/events/${eventId}/americano`);
    return res.data.data;
  } catch (err: any) {
    if (err?.response?.status === 404) return null;
    throw err;
  }
}

export type AmericanoStanding = {
  rank: number;
  user_id: number;
  name: string;
  avatar_url: string | null;
  points: number;
  played: number;
  wins: number;
};

export async function getAmericanoStandings(eventId: number): Promise<AmericanoStanding[]> {
  const res = await apiClient.get(`/events/${eventId}/americano/standings`);
  return res.data.data.standings as AmericanoStanding[];
}

export async function postAmericanoScore(
  matchId: number,
  scoreA: number,
  scoreB: number
): Promise<{ id: number; score_a: number; score_b: number; status: 'completed' }> {
  const res = await apiClient.post(`/americano/matches/${matchId}/score`, {
    score_a: scoreA,
    score_b: scoreB,
  });
  return res.data.data;
}

// ─── Shareable match card ────────────────────────────────
export type MatchCardSide = {
  registration_id: number;
  players: Array<{ user_id: number; name: string; avatar_url: string | null }>;
};
export type MatchCard = {
  match_id: number;
  uuid: string;
  round_name: string | null;
  is_final: boolean;
  completed_at: string | null;
  winner_registration_id: number | null;
  participant_1: MatchCardSide | null;
  participant_2: MatchCardSide | null;
  sets: Array<{ set: number; p1: number; p2: number; tiebreak: boolean }>;
  elo_delta: number | null;
  event: {
    id: number;
    title: string;
    sport_category: 'padel' | 'fifa' | 'other';
    sponsor_name: string | null;
    sponsor_logo_url: string | null;
  } | null;
  venue: { id: number; name: string; city: string } | null;
};

export async function getMatchCard(matchId: number): Promise<MatchCard> {
  const res = await apiClient.get(`/matches/${matchId}/card`);
  return res.data.data;
}

// ─── Spiel jetzt / Herausforderungen ─────────────────────
export type MatchRequestInvite = {
  user_id: number;
  status: 'invited' | 'accepted' | 'declined';
  name: string;
  avatar_url: string | null;
};
export type MatchRequest = {
  id: number;
  uuid: string;
  requester_id: number;
  request_type: 'open' | 'direct';
  sport: 'padel' | 'fifa';
  city: string | null;
  players_needed: number;
  slot_id: number | null;
  booking_id: number | null;
  status: 'searching' | 'matched' | 'booked' | 'cancelled' | 'expired';
  expires_at: string;
  invites: MatchRequestInvite[];
};

export async function createPlayNow(opts: {
  sport?: 'padel' | 'fifa';
  city?: string;
  slot_id?: number;
}): Promise<MatchRequest> {
  const res = await apiClient.post('/play-now', opts);
  return res.data.data;
}
export async function createChallenge(
  opponentUserId: number,
  opts: { sport?: 'padel' | 'fifa'; slot_id?: number } = {}
): Promise<MatchRequest> {
  const res = await apiClient.post('/challenges', { opponent_user_id: opponentUserId, ...opts });
  return res.data.data;
}
export async function listPlayNow(): Promise<MatchRequest[]> {
  const res = await apiClient.get('/play-now');
  return res.data.data;
}
export async function respondPlayNow(id: number, accept: boolean): Promise<MatchRequest> {
  const res = await apiClient.post(`/play-now/${id}/${accept ? 'accept' : 'decline'}`, {});
  return res.data.data;
}
export async function cancelPlayNow(id: number): Promise<{ id: number; status: 'cancelled' }> {
  const res = await apiClient.delete(`/play-now/${id}`);
  return res.data.data;
}

// ─── Engagement: Challenges, Feed, Streak, Seasons ───────
export type WeeklyChallenge = {
  id: string;
  week: string;
  title: string;
  target: number;
  progress: number;
  completed: boolean;
};
export async function getWeeklyChallenges(): Promise<WeeklyChallenge[]> {
  const res = await apiClient.get('/me/challenges');
  return res.data.data;
}

export type FeedItem = {
  type: 'friend_match' | 'friend_achievement' | 'city_event';
  ts: string;
  payload: Record<string, unknown>;
};
export async function getActivityFeed(): Promise<FeedItem[]> {
  const res = await apiClient.get('/me/feed');
  return res.data.data;
}

export async function getMyStreak(): Promise<{
  week_streak: number;
  longest_week_streak: number;
  last_played_week: string | null;
}> {
  const res = await apiClient.get('/me/streak');
  return res.data.data;
}

export async function getCurrentSeason(): Promise<{
  id: number;
  code: string;
  starts_at: string;
  ends_at: string;
} | null> {
  const res = await apiClient.get('/seasons/current');
  return res.data.data;
}
export async function getMySeasonHistory(): Promise<
  Array<{ code: string; sport: 'padel' | 'fifa'; final_elo: number; final_rank: number }>
> {
  const res = await apiClient.get('/me/seasons');
  return res.data.data;
}

// ─── Private Events ──────────────────────────────────────
export async function getEventByInvite(token: string) {
  const res = await apiClient.get(`/events/by-invite/${encodeURIComponent(token)}`);
  return res.data.data;
}

// ─── Live court queue ────────────────────────────────────
/**
 * The queue on a booked slot: join it, and when the court frees up it is
 * held for you for a few minutes while you decide.
 */
export type QueueStanding = {
  entry_id: number;
  position: number;
  queue_length: number;
  ahead_of_you: { free: number; plus: number; club: number };
  your_tier: 'free' | 'plus' | 'club';
  /** Null unless you are on the free tier — and honest when Plus buys nothing. */
  position_if_plus: number | null;
  auto_claim: boolean;
};

export type SlotDetail = AvailabilitySlot & {
  venue_name: string | null;
  venue_city: string | null;
  court_name: string | null;
  queue_length: number;
  hold: { expires_at: string } | null;
  my_entry: QueueStanding | null;
};

export type SlotOffer = {
  offer_id: number;
  expires_at: string;
  seconds_left: number;
};

export type MyQueueEntry = {
  entry_id: number;
  slot_id: number;
  status: 'queued' | 'offered';
  auto_claim: boolean;
  slot_date: string;
  slot_start: string;
  slot_end: string;
  price_cents: number | null;
  venue_id: number;
  venue_name: string | null;
  court_name: string | null;
  position: number | null;
  queue_length: number;
  offer: SlotOffer | null;
};

export async function getSlot(slotId: number): Promise<SlotDetail> {
  const res = await apiClient.get(`/slots/${slotId}`);
  return res.data.data;
}

export async function joinSlotQueue(
  slotId: number,
  opts: { autoClaim?: boolean } = {}
): Promise<QueueStanding> {
  const res = await apiClient.post(`/slots/${slotId}/waitlist`, {
    auto_claim: opts.autoClaim === true,
  });
  return res.data.data;
}

export async function leaveSlotQueue(slotId: number): Promise<void> {
  await apiClient.delete(`/slots/${slotId}/waitlist`);
}

export async function getMySlotStanding(slotId: number): Promise<QueueStanding> {
  const res = await apiClient.get(`/slots/${slotId}/waitlist/me`);
  return res.data.data;
}

/** Converts a held slot into a real booking. Same shape as POST /bookings. */
export async function claimSlot(slotId: number, offerId?: number): Promise<CourtBooking> {
  const res = await apiClient.post(`/slots/${slotId}/claim`, offerId ? { offer_id: offerId } : {});
  return res.data.data;
}

/** Passes the offer on immediately rather than letting it run out. */
export async function declineSlotOffer(slotId: number, offerId?: number): Promise<void> {
  await apiClient.post(`/slots/${slotId}/decline`, offerId ? { offer_id: offerId } : {});
}

export async function getMyQueue(): Promise<{
  queued: MyQueueEntry[];
  offers: MyQueueEntry[];
}> {
  const res = await apiClient.get('/me/waitlist');
  return res.data.data;
}

// ─── Moderation ──────────────────────────────────────────
/**
 * Reporting and blocking. Required by App Store Guideline 1.2 for any app
 * carrying user-generated content, and by the DSA as a notice-and-action
 * procedure.
 */
export type ReportContentType =
  | 'chat_message'
  | 'venue_review'
  | 'venue_photo'
  | 'profile'
  | 'feed_item';

export type ReportReason =
  | 'spam'
  | 'harassment'
  | 'hate_speech'
  | 'sexual'
  | 'violence'
  | 'other';

export async function reportContent(params: {
  contentType: ReportContentType;
  contentId: number;
  reason: ReportReason;
  details?: string;
}): Promise<{ id: number; status: string }> {
  const res = await apiClient.post('/reports', {
    content_type: params.contentType,
    content_id: params.contentId,
    reason: params.reason,
    details: params.details,
  });
  return res.data.data;
}

export async function blockUser(userId: number): Promise<void> {
  await apiClient.post(`/users/${userId}/block`);
}

export async function unblockUser(userId: number): Promise<void> {
  await apiClient.delete(`/users/${userId}/block`);
}

export async function listBlockedUsers(): Promise<
  Array<{ user_id: number; display_name: string | null; avatar_url: string | null; created_at: string }>
> {
  const res = await apiClient.get('/me/blocks');
  return res.data.data;
}
