/**
 * Night Court — Home screen.
 *
 * Layout (top → bottom):
 *   1. NCTopBar  (greeting + avatar + bell badge)
 *   2. ELO summary card with sparkline + Siege/Niederlagen/Winrate/Streak
 *   3. "Live jetzt" horizontal carousel (only when there are in_progress events)
 *   4. "Nächstes Turnier" hero card (gradient + court diagram + capacity bar)
 *   5. "Deine Termine" upcoming registrations list
 *   6. "Schnellzugriff" 2×2 grid of QuickTile entry-points
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  RefreshControl,
  Pressable,
} from 'react-native';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import {
  NCScreen,
  NCTopBar,
  NCCard,
  NCPill,
  NCButton,
  NCSection,
  NCSparkline,
  NCQuickTile,
  NCCapacityBar,
  NCCourtBackdrop,
  NCLivePulse,
  NCIcon,
  NC,
} from '../../src/components/nightcourt';
import { fontFamily } from '../../src/theme/typography';
import { useAuthStore } from '../../src/store/authStore';
import { useEventStore, type Event } from '../../src/store/eventStore';
import { useRegistrationStore } from '../../src/store/registrationStore';
import { useNotificationStore } from '../../src/store/notificationStore';
import { getMyElo, getMyEloHistory } from '../../src/api/v2';

interface EloSummary {
  elo: number;
  delta: number;
  rank: string;
  wins: number;
  losses: number;
  wr: number;
  streak: number;
  history: number[];
}

const FALLBACK_HISTORY = [1620, 1648, 1605, 1670, 1712, 1689, 1735, 1768, 1742, 1790, 1815, 1842];

// ─── Stat cell (Siege / Niederlagen / Winrate / Streak) ─────
const Stat: React.FC<{ value: string | number; label: string; color?: string; fire?: boolean }> = ({
  value,
  label,
  color,
  fire,
}) => (
  <View>
    <View style={s.statValueRow}>
      {fire ? <NCIcon name="flame" size={14} color={color || NC.gold} /> : null}
      <Text style={[s.statValue, { color: color || NC.textP }]}>{value}</Text>
    </View>
    <Text style={s.statLabel}>{label}</Text>
  </View>
);

// ─── Live match card (horizontal scroll) ─────────────────────
const LiveMatchCard: React.FC<{ event: Event; onPress: () => void }> = ({ event, onPress }) => {
  return (
    <NCCard onPress={onPress} padded={false} style={{ width: 280, padding: 14 }}>
      <View style={s.liveHeader}>
        <NCLivePulse />
        <Text style={s.liveSubtitle} numberOfLines={1}>
          {event.format ? event.format.toUpperCase() : 'MATCH'} · {event.venue?.name || ''}
        </Text>
      </View>
      <Text style={s.liveTitle} numberOfLines={2}>
        {event.title}
      </Text>
      <View style={s.liveFooter}>
        <Text style={s.liveFooterMeta}>
          {event.participant_count}/{event.max_participants} Teilnehmer
        </Text>
        <Text style={s.liveFooterScore}>JETZT</Text>
      </View>
    </NCCard>
  );
};

// ─── Hero card (Nächstes Turnier) ────────────────────────────
const HeroCard: React.FC<{
  event: Event;
  isMember: boolean;
  onPress: () => void;
  onRegister: () => void;
}> = ({ event, isMember, onPress, onRegister }) => {
  const fee = event.entry_fee_cents / 100;
  const prizeTotal = event.total_prize_pool_cents / 100;
  const filled = event.participant_count;
  const spots = event.max_participants;
  const fillPct = spots > 0 ? (filled / spots) * 100 : 0;
  const dateLabel = formatShortDate(event.start_date);
  const memberFee = isMember ? fee * 0.9 : fee;

  return (
    <View style={{ paddingHorizontal: 20 }}>
      <NCCard onPress={onPress} padded={false} glow>
        <View style={{ position: 'relative' }}>
          <NCCourtBackdrop height={160} />
          <View style={s.heroPills}>
            <NCPill color="#FFFFFF" bg="rgba(99,102,241,0.9)">
              NÄCHSTES TURNIER
            </NCPill>
            {isMember ? (
              <NCPill color={NC.goldLight} bg="rgba(245,158,11,0.18)" dot>
                MEMBER −10%
              </NCPill>
            ) : null}
          </View>
          {prizeTotal > 0 ? (
            <View style={s.heroPrizeBlock}>
              <Text style={s.heroPrizeLabel}>GARANTIERT</Text>
              <Text style={s.heroPrizeAmount}>{formatEuro(prizeTotal, 0)}</Text>
            </View>
          ) : null}
        </View>
        <View style={{ padding: 16 }}>
          <Text style={s.heroTitle} numberOfLines={2}>
            {event.title}
          </Text>
          <Text style={s.heroSub} numberOfLines={1}>
            {labelLevel(event.level)} · {labelFormat(event.format)}
          </Text>
          <View style={s.heroMeta}>
            <View style={s.metaRow}>
              <NCIcon name="calendar" size={14} color={NC.textS} />
              <Text style={s.metaText}>{dateLabel}</Text>
            </View>
            {event.venue?.name ? (
              <View style={s.metaRow}>
                <NCIcon name="pin" size={14} color={NC.textS} />
                <Text style={s.metaText} numberOfLines={1}>
                  {event.venue.name}
                </Text>
              </View>
            ) : null}
          </View>
          <View style={{ marginTop: 14 }}>
            <View style={s.capacityHeader}>
              <Text style={s.capacityLabel}>PLÄTZE</Text>
              <Text style={s.capacityCount}>
                {filled}/{spots}
              </Text>
            </View>
            <NCCapacityBar fill={fillPct} />
          </View>
          <View style={s.heroCtaRow}>
            <View>
              <Text style={s.heroFeeLabel}>{isMember ? 'PLUS-PREIS' : 'GEBÜHR'}</Text>
              <View style={s.feeRow}>
                <Text style={s.feeAmount}>{formatEuro(memberFee, 2)}</Text>
                {isMember && fee !== memberFee ? (
                  <Text style={s.feeStrike}>{formatEuro(fee, 0)}</Text>
                ) : null}
              </View>
            </View>
            <NCButton variant="primary" size="md" iconRight="arrowR" onPress={onRegister}>
              Anmelden
            </NCButton>
          </View>
        </View>
      </NCCard>
    </View>
  );
};

// ─── Termine row ─────────────────────────────────────────────
const TermineRow: React.FC<{
  date: { d: string; m: string };
  title: string;
  meta: string;
  onPress: () => void;
}> = ({ date, title, meta, onPress }) => {
  return (
    <NCCard onPress={onPress} padded={false} style={s.termineRow}>
      <View style={s.termineDate}>
        <Text style={s.termineDay}>{date.d}</Text>
        <Text style={s.termineMonth}>{date.m}</Text>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={s.termineTitle} numberOfLines={1}>
          {title}
        </Text>
        <Text style={s.termineMeta} numberOfLines={1}>
          {meta}
        </Text>
      </View>
      <NCIcon name="chevron" size={16} color={NC.textT} />
    </NCCard>
  );
};

// ─── Helpers ────────────────────────────────────────────────
function formatShortDate(iso: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('de', { weekday: 'short', day: 'numeric', month: 'short' });
  } catch {
    return iso.substring(0, 10);
  }
}
function formatEuro(amount: number, frac = 2): string {
  return amount.toLocaleString('de', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: frac,
    maximumFractionDigits: frac,
  });
}
function labelLevel(level?: string): string {
  return ({ beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced', pro: 'Pro', open: 'Offen' } as Record<string, string>)[level || ''] || 'Open';
}
function labelFormat(format?: string): string {
  return ({ singles: 'Einzel', doubles: 'Duo', team: 'Team' } as Record<string, string>)[format || ''] || 'Padel';
}
function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Guten Morgen';
  if (h < 18) return 'Guten Tag';
  return 'Guten Abend';
}

// ─── Main screen ────────────────────────────────────────────
export default function HomeScreen() {
  const router = useRouter();
  const { user } = useAuthStore();
  const { events, fetchEvents } = useEventStore();
  const { myRegistrations, fetchMyRegistrations } = useRegistrationStore();
  const unreadCount = useNotificationStore((st) => st.unreadCount);
  const [refreshing, setRefreshing] = useState(false);
  const [elo, setElo] = useState<EloSummary | null>(null);

  const loadData = useCallback(async () => {
    const tasks: Promise<unknown>[] = [fetchEvents()];
    if (user) {
      tasks.push(fetchMyRegistrations());
      tasks.push(loadEloSummary().then(setElo).catch(() => {}));
    }
    await Promise.all(tasks);
  }, [user, fetchEvents, fetchMyRegistrations]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  }, [loadData]);

  const heroEvent = useMemo<Event | undefined>(() => {
    return events.find((e) => e.status === 'published' || e.status === 'registration_open') ?? events[0];
  }, [events]);

  const liveEvents = useMemo(
    () => events.filter((e) => e.status === 'in_progress').slice(0, 4),
    [events]
  );

  const upcomingRegs = useMemo(
    () =>
      myRegistrations
        .filter((r) => r.status === 'confirmed' || r.status === 'waitlisted')
        .slice(0, 5),
    [myRegistrations]
  );

  const isMember = !!user && (user as any).membership_tier && (user as any).membership_tier !== 'free';
  const displayName = user?.display_name || user?.first_name || 'Spieler';

  return (
    <NCScreen>
      <ScrollView
        contentContainerStyle={{ paddingBottom: 110 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={NC.primaryLight}
          />
        }
      >
        <NCTopBar
          greeting={getGreeting()}
          name={displayName}
          badge={unreadCount}
          onAvatar={() => router.push('/(tabs)/profil')}
          onBell={() => router.push('/notifications')}
        />

        {/* ── ELO summary card ───────────────────── */}
        <View style={{ paddingHorizontal: 20, marginBottom: 20 }}>
          <NCCard padded={false} style={{ overflow: 'hidden' }}>
            <LinearGradient
              colors={[NC.bgCard, 'rgba(79,70,229,0.18)']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={{ padding: 18 }}
            >
              <View style={s.eloHeader}>
                <View style={{ flex: 1 }}>
                  <Text style={s.eloLabel}>DEINE WERTUNG</Text>
                  <View style={s.eloValueRow}>
                    <Text style={s.eloBig}>{elo?.elo ?? '—'}</Text>
                    {elo && elo.delta !== 0 ? (
                      <View style={s.eloDelta}>
                        <NCIcon
                          name={elo.delta >= 0 ? 'arrowU' : 'arrowD'}
                          size={12}
                          color={elo.delta >= 0 ? NC.green : NC.coral}
                          strokeWidth={2.5}
                        />
                        <Text
                          style={[s.eloDeltaText, { color: elo.delta >= 0 ? NC.green : NC.coral }]}
                        >
                          {elo.delta > 0 ? '+' : ''}{elo.delta}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                </View>
                <View style={s.rankPill}>
                  <NCIcon name="crown" size={14} color={NC.gold} />
                  <Text style={s.rankText}>Rang {elo?.rank || 'A'}</Text>
                </View>
              </View>

              <NCSparkline data={elo?.history?.length ? elo.history : FALLBACK_HISTORY} width={310} height={50} />

              <View style={s.statsRow}>
                <Stat value={elo?.wins ?? 0} label="Siege" color={NC.green} />
                <Stat value={elo?.losses ?? 0} label="Niederlagen" />
                <Stat value={`${elo?.wr ?? 0}%`} label="Winrate" color={NC.primaryLight} />
                <Stat value={elo?.streak ?? 0} label="Streak" color={NC.gold} fire />
              </View>
            </LinearGradient>
          </NCCard>
        </View>

        {/* ── Live now ───────────────────────────── */}
        {liveEvents.length > 0 ? (
          <NCSection title="Live jetzt" onAction={() => router.push('/(tabs)/turniere')}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 20, gap: 12 }}
            >
              {liveEvents.map((e) => (
                <LiveMatchCard
                  key={e.id}
                  event={e}
                  onPress={() => router.push(`/event/${e.id}`)}
                />
              ))}
            </ScrollView>
          </NCSection>
        ) : null}

        {/* ── Hero ───────────────────────────────── */}
        {heroEvent ? (
          <NCSection
            title="Nächstes Turnier"
            onAction={() => router.push('/(tabs)/turniere')}
          >
            <HeroCard
              event={heroEvent}
              isMember={isMember}
              onPress={() => router.push(`/event/${heroEvent.id}`)}
              onRegister={() => router.push(`/event/${heroEvent.id}`)}
            />
          </NCSection>
        ) : null}

        {/* ── Deine Termine ──────────────────────── */}
        {upcomingRegs.length > 0 ? (
          <NCSection title="Deine Termine" onAction={() => router.push('/(tabs)/turniere')}>
            <View style={{ paddingHorizontal: 20, gap: 10 }}>
              {upcomingRegs.map((r) => {
                const date = parseDateParts(r.event_date);
                return (
                  <TermineRow
                    key={r.id}
                    date={date}
                    title={r.event_title || 'Turnier'}
                    meta={r.event_location || (r.partner_name ? `Partner: ${r.partner_name}` : '')}
                    onPress={() => router.push(`/event/${r.event_id}`)}
                  />
                );
              })}
            </View>
          </NCSection>
        ) : null}

        {/* ── Quick access ───────────────────────── */}
        <NCSection title="Schnellzugriff">
          <View style={{ paddingHorizontal: 20, gap: 10 }}>
            <View style={s.tileRow}>
              <NCQuickTile
                icon="zap"
                label="Spiel jetzt"
                sub="Match in 1 Tap"
                hue={280}
                onPress={() => router.push('/play-now')}
              />
              <NCQuickTile
                icon="flame"
                label="Challenges"
                sub="Streak halten"
                hue={20}
                onPress={() => router.push('/challenges')}
              />
            </View>
            <View style={s.tileRow}>
              <NCQuickTile
                icon="bell"
                label="Aktivität"
                sub="Was Freunde spielen"
                hue={220}
                onPress={() => router.push('/feed')}
              />
              <NCQuickTile
                icon="bolt"
                label="Matchmaking"
                sub="Spieler nach ELO"
                hue={260}
                onPress={() => router.push('/matchmaking')}
              />
            </View>
            <View style={s.tileRow}>
              <NCQuickTile
                icon="pin"
                label="Courts"
                sub="Venues entdecken"
                hue={200}
                onPress={() => router.push('/(tabs)/turniere')}
              />
              <NCQuickTile
                icon="medal"
                label="Leaderboard"
                sub="Top 100"
                hue={40}
                onPress={() => router.push('/leaderboard')}
              />
            </View>
          </View>
        </NCSection>

        <View style={{ height: 20 }} />
      </ScrollView>
    </NCScreen>
  );
}

// ─── ELO loader ────────────────────────────────────────────
async function loadEloSummary(): Promise<EloSummary> {
  const [eloRes, history] = await Promise.all([
    getMyElo().catch(() => null),
    getMyEloHistory('padel', 12).catch(() => [] as { elo: number }[]),
  ]);
  const points = history.map((h) => h.elo);
  const ranked = eloRes?.padel?.tier;
  const rank = ranked ? ranked.charAt(0).toUpperCase() : 'A';
  // Win/loss/streak aren't returned by /me/elo; default to 0 until the
  // backend exposes them via /me/stats.  Keep the design's slot rather than
  // hiding the row.
  return {
    elo: eloRes?.padel?.elo ?? 0,
    delta: points.length > 1 ? points[points.length - 1] - points[points.length - 2] : 0,
    rank,
    wins: 0,
    losses: 0,
    wr: 0,
    streak: 0,
    history: points,
  };
}

function parseDateParts(iso?: string): { d: string; m: string } {
  if (!iso) return { d: '?', m: '' };
  try {
    const d = new Date(iso);
    return {
      d: String(d.getDate()),
      m: d.toLocaleDateString('de', { month: 'short' }).replace('.', '').toUpperCase(),
    };
  } catch {
    return { d: '?', m: '' };
  }
}

// ─── Styles ────────────────────────────────────────────────
const s = StyleSheet.create({
  eloHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  eloLabel: {
    fontFamily: fontFamily.uiSemibold,
    fontSize: 11,
    color: NC.textS,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  eloValueRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 4 },
  eloBig: {
    fontFamily: fontFamily.monoBold,
    fontSize: 38,
    fontWeight: '700',
    color: NC.textP,
    letterSpacing: -1.5,
    lineHeight: 40,
    includeFontPadding: false,
  },
  eloDelta: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  eloDeltaText: { fontFamily: fontFamily.uiBold, fontSize: 13, fontWeight: '700' },
  rankPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    backgroundColor: 'rgba(245,158,11,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(245,158,11,0.3)',
  },
  rankText: {
    fontFamily: fontFamily.displayBold,
    fontSize: 13,
    fontWeight: '700',
    color: NC.gold,
  },
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: NC.border,
  },
  statValueRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  statValue: {
    fontFamily: fontFamily.monoBold,
    fontSize: 17,
    fontWeight: '700',
    lineHeight: 18,
  },
  statLabel: {
    marginTop: 4,
    fontFamily: fontFamily.uiMedium,
    fontSize: 10.5,
    color: NC.textT,
    letterSpacing: 0.3,
    textTransform: 'uppercase',
    fontWeight: '500',
  },

  // hero
  heroPills: {
    position: 'absolute',
    top: 14,
    left: 14,
    flexDirection: 'row',
    gap: 6,
  },
  heroPrizeBlock: { position: 'absolute', bottom: 14, right: 14, alignItems: 'flex-end' },
  heroPrizeLabel: {
    fontFamily: fontFamily.monoBold,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1,
    color: NC.gold,
  },
  heroPrizeAmount: {
    fontFamily: fontFamily.displayExtra,
    fontSize: 24,
    fontWeight: '800',
    color: NC.gold,
    letterSpacing: -0.5,
    lineHeight: 26,
  },
  heroTitle: {
    fontFamily: fontFamily.displayBold,
    fontSize: 20,
    fontWeight: '700',
    color: NC.textP,
    letterSpacing: -0.4,
    lineHeight: 23,
  },
  heroSub: { marginTop: 4, fontFamily: fontFamily.uiMedium, fontSize: 13, color: NC.textS },
  heroMeta: { flexDirection: 'row', gap: 14, marginTop: 14 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  metaText: { fontFamily: fontFamily.uiMedium, fontSize: 12.5, color: NC.textS, maxWidth: 160 },
  capacityHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  capacityLabel: {
    fontFamily: fontFamily.uiSemibold,
    fontSize: 11,
    color: NC.textT,
    fontWeight: '600',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  capacityCount: { fontFamily: fontFamily.monoBold, fontSize: 11.5, fontWeight: '700', color: NC.textP },
  heroCtaRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 16 },
  heroFeeLabel: {
    fontFamily: fontFamily.uiSemibold,
    fontSize: 10.5,
    color: NC.textT,
    fontWeight: '600',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  feeRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  feeAmount: {
    fontFamily: fontFamily.displayBold,
    fontSize: 20,
    fontWeight: '700',
    color: NC.textP,
  },
  feeStrike: {
    fontFamily: fontFamily.uiMedium,
    fontSize: 12,
    color: NC.textT,
    textDecorationLine: 'line-through',
  },

  // live cards
  liveHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  liveSubtitle: {
    fontFamily: fontFamily.uiSemibold,
    fontSize: 10.5,
    color: NC.textS,
    fontWeight: '600',
    letterSpacing: 0.5,
    flexShrink: 1,
    marginLeft: 8,
  },
  liveTitle: {
    fontFamily: fontFamily.displayBold,
    fontSize: 14,
    fontWeight: '700',
    color: NC.textP,
    letterSpacing: -0.2,
  },
  liveFooter: {
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: NC.border,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  liveFooterMeta: { fontFamily: fontFamily.uiMedium, fontSize: 11, color: NC.textS },
  liveFooterScore: {
    fontFamily: fontFamily.monoBold,
    fontSize: 12,
    fontWeight: '700',
    color: NC.coral,
  },

  // termine
  termineRow: { padding: 12, flexDirection: 'row', alignItems: 'center', gap: 14 },
  termineDate: {
    width: 54,
    height: 54,
    borderRadius: 14,
    backgroundColor: NC.primaryBg,
    borderWidth: 1,
    borderColor: NC.borderStr,
    alignItems: 'center',
    justifyContent: 'center',
  },
  termineDay: {
    fontFamily: fontFamily.displayExtra,
    fontSize: 22,
    fontWeight: '800',
    color: NC.primaryLight,
    lineHeight: 23,
  },
  termineMonth: {
    marginTop: 2,
    fontFamily: fontFamily.uiBold,
    fontSize: 9,
    fontWeight: '700',
    color: NC.primaryLight,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  termineTitle: {
    fontFamily: fontFamily.displaySemibold,
    fontSize: 15,
    fontWeight: '600',
    color: NC.textP,
    letterSpacing: -0.2,
  },
  termineMeta: { marginTop: 2, fontFamily: fontFamily.uiMedium, fontSize: 12, color: NC.textS },

  // tiles
  tileRow: { flexDirection: 'row', gap: 10 },
});
