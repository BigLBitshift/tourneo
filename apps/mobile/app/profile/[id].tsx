/**
 * Public Player Profile — /profile/[id]
 *
 * Shows a player's ELO, rating history chart, win rate, form, head-to-head
 * against the current user. Used by the matchmaking screen when tapping a
 * player card. Better than Playtomic: combines rating, form, H2H and chart
 * on a single screen.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Share,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../src/providers/ThemeProvider';
import type { Colors } from '../../src/theme/colors';
import { spacing, fontSize, fontWeight, radius } from '../../src/theme/spacing';
import { TAvatar, TRatingBadge, TRatingChart, TEmptyState, type RatingPoint } from '../../src/components/common';
import { useAuthStore } from '../../src/store/authStore';
import {
  getPublicProfile,
  getHeadToHead,
  getPlayerEloHistory,
  createChallenge,
  type PublicPlayerProfile,
  type HeadToHead as HeadToHeadData,
} from '../../src/api/v2';
import { useToast } from '../../src/components/common';
import * as Haptics from 'expo-haptics';

type Sport = 'padel' | 'fifa';

export default function PlayerProfileScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const me = useAuthStore((s) => s.user);
  const targetId = Number(id);
  const isSelf = me?.id === targetId;

  const [sport, setSport] = useState<Sport>('padel');
  const [profile, setProfile] = useState<PublicPlayerProfile | null>(null);
  const [history, setHistory] = useState<RatingPoint[]>([]);
  const [h2h, setH2h] = useState<HeadToHeadData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!Number.isFinite(targetId) || targetId <= 0) {
      setError('Ungültige Profil-ID');
      setLoading(false);
      return;
    }
    try {
      setError(null);
      const [p, hist, h] = await Promise.all([
        getPublicProfile(targetId),
        getPlayerEloHistory(targetId, sport, 30).catch(() => []),
        isSelf ? Promise.resolve(null) : getHeadToHead(targetId).catch(() => null),
      ]);
      setProfile(p);
      setHistory(hist.map((x) => ({ elo: x.elo, recorded_at: x.recorded_at })));
      setH2h(h);
    } catch (e: any) {
      setError(e?.response?.data?.error ?? e?.message ?? 'Profil konnte nicht geladen werden');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [targetId, sport, isSelf]);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = () => {
    setRefreshing(true);
    load();
  };

  const onShare = async () => {
    if (!profile) return;
    try {
      await Share.share({
        message: `${profile.display_name} — ELO ${sport === 'padel' ? profile.padel.elo : profile.fifa.elo} · ${profile.stats.matches_won}W/${profile.stats.matches_lost}L auf Tourneo`,
      });
    } catch {}
  };

  if (loading) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.bg }]}>
        <ActivityIndicator color={colors.primary as string} style={{ marginTop: 100 }} />
      </SafeAreaView>
    );
  }

  if (error || !profile) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.bg }]}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.header}>
          <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} hitSlop={10}>
            <Ionicons name="chevron-back" size={26} color={colors.textPrimary as string} />
          </TouchableOpacity>
        </View>
        <TEmptyState title="Profil nicht verfügbar" message={error ?? 'Unbekannter Fehler'} icon="👤" />
      </SafeAreaView>
    );
  }

  const eloBlock = sport === 'padel' ? profile.padel : profile.fifa;
  const tierNormalized = (eloBlock.tier === 'elite' ? 'diamond' : eloBlock.tier) as any;
  const notDiscoverable = !profile.discoverable && !isSelf;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.bg }]} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="chevron-back" size={26} color={colors.textPrimary as string} />
        </TouchableOpacity>
        <View style={{ flex: 1 }} />
        {!notDiscoverable && (
          <TouchableOpacity style={styles.shareBtn} onPress={onShare} hitSlop={10}>
            <Ionicons name="share-outline" size={22} color={colors.textPrimary as string} />
          </TouchableOpacity>
        )}
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: 80 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary as string} />}
      >
        {/* Identity */}
        <View style={styles.identity}>
          <TAvatar name={profile.display_name} uri={profile.avatar_url ?? undefined} size="xl" />
          <Text style={styles.name}>{profile.display_name}</Text>
          <View style={styles.metaRow}>
            {profile.city && <Text style={styles.metaText}>📍 {profile.city}</Text>}
            <Text style={styles.metaText}>Dabei seit {new Date(profile.member_since).getFullYear()}</Text>
          </View>
          {profile.bio && <Text style={styles.bio}>{profile.bio}</Text>}
          {!isSelf && !notDiscoverable && (
            <ChallengeButton
              targetUserId={targetId}
              targetName={profile.display_name}
              sport={sport}
              colors={colors}
            />
          )}
        </View>

        {notDiscoverable && (
          <View style={styles.privateCard}>
            <Ionicons name="lock-closed-outline" size={20} color={colors.textTertiary as string} />
            <Text style={styles.privateText}>
              Dieses Profil ist privat. Der Spieler hat Statistiken ausgeblendet.
            </Text>
          </View>
        )}

        {!notDiscoverable && (
          <>
            {/* Sport toggle */}
            <View style={styles.sportToggle}>
              <Pill active={sport === 'padel'} onPress={() => setSport('padel')} label="🏸 Padel" colors={colors} />
              <Pill active={sport === 'fifa'} onPress={() => setSport('fifa')} label="🎮 FIFA" colors={colors} />
            </View>

            {/* Rating block */}
            <View style={styles.ratingBlock}>
              <View style={styles.ratingRow}>
                <View>
                  <Text style={styles.smallLabel}>ELO {sport === 'padel' ? 'Padel' : 'FIFA'}</Text>
                  <Text style={styles.eloBig}>{eloBlock.elo}</Text>
                  <Text style={styles.peakLabel}>Peak {eloBlock.peak}</Text>
                </View>
                <TRatingBadge elo={eloBlock.elo} tier={tierNormalized} size="lg" showTierLabel />
              </View>
              {history.length > 1 && (
                <TRatingChart points={history} height={110} showAxis={false} showDelta={false} />
              )}
            </View>

            {/* Stats grid */}
            <View style={styles.statsGrid}>
              <StatTile label="Matches" value={String(profile.stats.matches_played)} colors={colors} />
              <StatTile label="Win-Rate" value={`${profile.stats.win_rate}%`} colors={colors} accent={profile.stats.win_rate >= 50} />
              <StatTile
                label={profile.stats.streak_type === 'win' ? 'Siegesserie' : profile.stats.streak_type === 'loss' ? 'Niederlagen' : 'Streak'}
                value={profile.stats.current_streak > 0 ? `${profile.stats.current_streak}` : '—'}
                colors={colors}
                accent={profile.stats.streak_type === 'win'}
                danger={profile.stats.streak_type === 'loss'}
              />
              <StatTile label="Turniere" value={String(profile.tournaments_played)} colors={colors} />
              <StatTile label="Achievements" value={String(profile.achievements_count)} colors={colors} />
              <StatTile label="Siege" value={`${profile.stats.matches_won}`} colors={colors} />
            </View>

            {/* Form (last 5) */}
            {profile.stats.last_5.length > 0 && (
              <View style={styles.formSection}>
                <Text style={styles.sectionTitle}>Form (letzte 5)</Text>
                <View style={styles.formRow}>
                  {profile.stats.last_5.map((r, i) => (
                    <View
                      key={i}
                      style={[
                        styles.formCircle,
                        { backgroundColor: r === 'W' ? (colors.success as string) : (colors.error as string) },
                      ]}
                    >
                      <Text style={styles.formCircleText}>{r}</Text>
                    </View>
                  ))}
                </View>
              </View>
            )}

            {/* Head-to-Head (only if not self) */}
            {!isSelf && h2h && h2h.total_matches > 0 && (
              <View style={styles.h2hSection}>
                <Text style={styles.sectionTitle}>Head-to-Head</Text>
                <View style={styles.h2hBar}>
                  <View style={[styles.h2hSide, { flex: Math.max(h2h.my_wins, 0.5) }]}>
                    <Text style={styles.h2hMe}>{h2h.my_wins}</Text>
                    <Text style={styles.h2hLabel}>Du</Text>
                  </View>
                  <Text style={styles.h2hDivider}>:</Text>
                  <View style={[styles.h2hSide, { flex: Math.max(h2h.opponent_wins, 0.5), alignItems: 'flex-end' }]}>
                    <Text style={styles.h2hOpp}>{h2h.opponent_wins}</Text>
                    <Text style={styles.h2hLabel}>{profile.display_name}</Text>
                  </View>
                </View>
                <View style={{ gap: 6, marginTop: spacing.sm }}>
                  {h2h.recent_matches.slice(0, 5).map((m) => (
                    <View key={m.match_id} style={styles.h2hMatchRow}>
                      <View style={[styles.resultDot, { backgroundColor: m.won ? (colors.success as string) : (colors.error as string) }]} />
                      <Text style={styles.h2hMatchText} numberOfLines={1}>{m.event_title}</Text>
                      <Text style={styles.h2hMatchDate}>{m.completed_at ? new Date(m.completed_at).toLocaleDateString('de-DE') : ''}</Text>
                    </View>
                  ))}
                </View>
              </View>
            )}

            {!isSelf && h2h && h2h.total_matches === 0 && (
              <View style={styles.h2hSection}>
                <Text style={styles.sectionTitle}>Head-to-Head</Text>
                <Text style={styles.emptyH2hText}>Noch keine gemeinsamen Matches — fordere diesen Spieler heraus!</Text>
              </View>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function ChallengeButton({
  targetUserId,
  targetName,
  sport,
  colors,
}: {
  targetUserId: number;
  targetName: string;
  sport: Sport;
  colors: Colors;
}) {
  const showToast = useToast((s) => s.show);
  const [busy, setBusy] = useState(false);

  const onChallenge = async () => {
    if (busy) return;
    Alert.alert(
      `${targetName} herausfordern?`,
      'Wir senden eine Match-Anfrage. Sobald sie zustimmt, könnt ihr Platz und Zeit absprechen.',
      [
        { text: 'Abbrechen', style: 'cancel' },
        {
          text: 'Herausfordern',
          onPress: async () => {
            setBusy(true);
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
            try {
              await createChallenge(targetUserId, { sport });
              showToast(
                'success',
                'Herausforderung gesendet',
                `Wir benachrichtigen dich, sobald ${targetName} antwortet.`
              );
            } catch (err: any) {
              const msg =
                err?.response?.data?.error?.message ||
                'Anfrage konnte nicht gesendet werden.';
              showToast('error', 'Fehler', msg);
            } finally {
              setBusy(false);
            }
          },
        },
      ]
    );
  };

  return (
    <TouchableOpacity
      onPress={onChallenge}
      disabled={busy}
      activeOpacity={0.85}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        backgroundColor: colors.primary as string,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.sm,
        borderRadius: radius.md,
        marginTop: spacing.md,
        opacity: busy ? 0.7 : 1,
        minHeight: 42,
        justifyContent: 'center',
      }}
    >
      {busy ? (
        <ActivityIndicator color="#FFF" />
      ) : (
        <>
          <Ionicons name="flash" size={16} color="#FFF" />
          <Text style={{ color: '#FFF', fontSize: fontSize.sm, fontWeight: fontWeight.bold as any }}>
            Herausfordern
          </Text>
        </>
      )}
    </TouchableOpacity>
  );
}

function Pill({ active, onPress, label, colors }: { active: boolean; onPress: () => void; label: string; colors: Colors }) {
  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={onPress}
      style={{
        paddingHorizontal: spacing.md,
        paddingVertical: 8,
        borderRadius: 999,
        backgroundColor: active ? (colors.primary as string) : (colors.cardBg as string),
        borderWidth: 1,
        borderColor: active ? (colors.primary as string) : (colors.cardBorder as string),
        marginRight: 8,
      }}
    >
      <Text
        style={{
          color: active ? '#FFFFFF' : (colors.textPrimary as string),
          fontSize: fontSize.sm,
          fontWeight: fontWeight.semibold as any,
        }}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function StatTile({
  label, value, colors, accent, danger,
}: {
  label: string; value: string; colors: Colors; accent?: boolean; danger?: boolean;
}) {
  const valueColor = danger
    ? (colors.error as string)
    : accent
    ? (colors.success as string)
    : (colors.textPrimary as string);
  return (
    <View style={{
      flexBasis: '31%',
      backgroundColor: colors.cardBg as string,
      borderWidth: 1,
      borderColor: colors.cardBorder as string,
      borderRadius: radius.lg,
      padding: spacing.sm,
      alignItems: 'center',
    }}>
      <Text style={{ color: valueColor, fontSize: fontSize.xl, fontWeight: fontWeight.bold as any }}>{value}</Text>
      <Text style={{ color: colors.textTertiary as string, fontSize: fontSize.xxs, marginTop: 2 }}>{label}</Text>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    container: { flex: 1 },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    backBtn: { padding: 4 },
    shareBtn: { padding: 4 },
    identity: {
      alignItems: 'center',
      paddingHorizontal: spacing.md,
      paddingTop: spacing.sm,
      paddingBottom: spacing.md,
    },
    name: {
      fontSize: fontSize.xxl,
      fontWeight: fontWeight.bold as any,
      color: colors.textPrimary as string,
      marginTop: spacing.sm,
      letterSpacing: -0.5,
    },
    metaRow: {
      flexDirection: 'row',
      gap: spacing.md,
      marginTop: 4,
    },
    metaText: {
      color: colors.textSecondary as string,
      fontSize: fontSize.xs,
    },
    bio: {
      color: colors.textSecondary as string,
      fontSize: fontSize.sm,
      textAlign: 'center',
      marginTop: spacing.sm,
      paddingHorizontal: spacing.lg,
      lineHeight: 20,
    },
    privateCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      padding: spacing.md,
      margin: spacing.md,
      borderRadius: radius.lg,
      backgroundColor: colors.cardBg as string,
      borderWidth: 1,
      borderColor: colors.cardBorder as string,
    },
    privateText: {
      color: colors.textSecondary as string,
      fontSize: fontSize.sm,
      flex: 1,
    },
    sportToggle: {
      flexDirection: 'row',
      paddingHorizontal: spacing.md,
      marginTop: spacing.sm,
      marginBottom: spacing.md,
    },
    ratingBlock: {
      marginHorizontal: spacing.md,
      padding: spacing.md,
      backgroundColor: colors.cardBg as string,
      borderWidth: 1,
      borderColor: colors.cardBorder as string,
      borderRadius: radius.lg,
    },
    ratingRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: spacing.sm,
    },
    smallLabel: { color: colors.textTertiary as string, fontSize: fontSize.xs, textTransform: 'uppercase', letterSpacing: 0.5 },
    eloBig: { color: colors.textPrimary as string, fontSize: 42, fontWeight: fontWeight.bold as any, lineHeight: 46 },
    peakLabel: { color: colors.textTertiary as string, fontSize: fontSize.xs, marginTop: 2 },
    statsGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      marginTop: spacing.md,
    },
    formSection: { padding: spacing.md },
    sectionTitle: { color: colors.textPrimary as string, fontSize: fontSize.md, fontWeight: fontWeight.semibold as any, marginBottom: spacing.sm },
    formRow: { flexDirection: 'row', gap: 6 },
    formCircle: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
    formCircleText: { color: '#FFFFFF', fontSize: fontSize.sm, fontWeight: fontWeight.bold as any },
    h2hSection: { padding: spacing.md, paddingTop: 0 },
    h2hBar: {
      flexDirection: 'row',
      alignItems: 'center',
      padding: spacing.md,
      borderRadius: radius.lg,
      backgroundColor: colors.cardBg as string,
      borderWidth: 1,
      borderColor: colors.cardBorder as string,
    },
    h2hSide: { flex: 1 },
    h2hMe: { color: colors.success as string, fontSize: 32, fontWeight: fontWeight.bold as any },
    h2hOpp: { color: colors.primary as string, fontSize: 32, fontWeight: fontWeight.bold as any },
    h2hDivider: { color: colors.textTertiary as string, fontSize: 28, fontWeight: fontWeight.bold as any, marginHorizontal: spacing.md },
    h2hLabel: { color: colors.textSecondary as string, fontSize: fontSize.xs },
    h2hMatchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingVertical: 6,
    },
    resultDot: { width: 10, height: 10, borderRadius: 5 },
    h2hMatchText: { flex: 1, color: colors.textPrimary as string, fontSize: fontSize.sm },
    h2hMatchDate: { color: colors.textTertiary as string, fontSize: fontSize.xs },
    emptyH2hText: {
      color: colors.textTertiary as string,
      fontSize: fontSize.sm,
      padding: spacing.md,
      backgroundColor: colors.cardBg as string,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.cardBorder as string,
      textAlign: 'center',
    },
  });
