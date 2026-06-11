/**
 * Challenges screen — weekly quests + streak summary.
 *
 * /me/challenges returns 3 live-computed quests; /me/streak gives the
 * current week-streak. Together they form the "one more game" hook:
 * the user sees exactly what they need to do to stay on streak and
 * complete this week's quests.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../src/providers/ThemeProvider';
import { spacing, fontSize, fontWeight, radius } from '../src/theme/spacing';
import {
  getWeeklyChallenges,
  getMyStreak,
  type WeeklyChallenge,
} from '../src/api/v2';

interface StreakInfo {
  week_streak: number;
  longest_week_streak: number;
  last_played_week: string | null;
}

export default function ChallengesScreen() {
  const { colors } = useTheme();
  const [challenges, setChallenges] = useState<WeeklyChallenge[] | null>(null);
  const [streak, setStreak] = useState<StreakInfo | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [c, s] = await Promise.all([getWeeklyChallenges(), getMyStreak()]);
      setChallenges(c);
      setStreak(s);
    } catch (err: any) {
      setError(err?.response?.data?.error?.message || 'Konnte nicht geladen werden.');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  if (!challenges || !streak) {
    return (
      <View style={[styles.loader, { backgroundColor: colors.bg }]}>
        <Stack.Screen options={{ title: 'Challenges', headerShown: true }} />
        {error ? (
          <Text style={[styles.errorText, { color: colors.error }]}>{error}</Text>
        ) : (
          <ActivityIndicator color={colors.primary} />
        )}
      </View>
    );
  }

  const completed = challenges.filter((c) => c.completed).length;

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <Stack.Screen options={{ title: 'Challenges', headerShown: true }} />
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        }
      >
        <View style={[styles.streakCard, { backgroundColor: colors.primary }]}>
          <View style={styles.streakRow}>
            <Text style={styles.streakEmoji}>🔥</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.streakLabel}>WOCHEN-SERIE</Text>
              <Text style={styles.streakValue}>
                {streak.week_streak} {streak.week_streak === 1 ? 'Woche' : 'Wochen'}
              </Text>
              {streak.longest_week_streak > streak.week_streak ? (
                <Text style={styles.streakSub}>
                  Rekord: {streak.longest_week_streak} Wochen
                </Text>
              ) : (
                <Text style={styles.streakSub}>Persönlicher Rekord 🏆</Text>
              )}
            </View>
          </View>
        </View>

        <View style={styles.headerRow}>
          <Text style={[styles.heading, { color: colors.textPrimary }]}>Diese Woche</Text>
          <Text style={[styles.headingCount, { color: colors.textTertiary }]}>
            {completed}/{challenges.length} erledigt
          </Text>
        </View>

        {challenges.map((c) => (
          <ChallengeCard key={c.id} challenge={c} colors={colors} />
        ))}

        <Text style={[styles.footnote, { color: colors.textTertiary }]}>
          Challenges starten Montag und enden Sonntag. Zähler aktualisieren sich
          nach jedem abgeschlossenen Match.
        </Text>
      </ScrollView>
    </View>
  );
}

function ChallengeCard({
  challenge,
  colors,
}: {
  challenge: WeeklyChallenge;
  colors: ReturnType<typeof useTheme>['colors'];
}) {
  const pct = Math.min(1, challenge.progress / challenge.target);
  const done = challenge.completed;
  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: colors.surface,
          borderColor: done ? colors.success : colors.cardBorder,
        },
      ]}
    >
      <View style={styles.cardHeader}>
        <Text
          style={[
            styles.cardTitle,
            { color: done ? colors.success : colors.textPrimary },
          ]}
          numberOfLines={2}
        >
          {challenge.title}
        </Text>
        {done && <Ionicons name="checkmark-circle" size={22} color={colors.success} />}
      </View>
      <View style={[styles.progressTrack, { backgroundColor: colors.surfaceSecondary }]}>
        <View
          style={[
            styles.progressFill,
            {
              width: `${pct * 100}%`,
              backgroundColor: done ? colors.success : colors.primary,
            },
          ]}
        />
      </View>
      <Text style={[styles.progressLabel, { color: colors.textTertiary }]}>
        {challenge.progress} / {challenge.target}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  loader: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  errorText: { fontSize: fontSize.sm, textAlign: 'center' },
  scroll: { padding: spacing.lg, paddingBottom: 100 },
  streakCard: { padding: spacing.lg, borderRadius: radius.lg, marginBottom: spacing.lg },
  streakRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  streakEmoji: { fontSize: 44 },
  streakLabel: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: fontSize.xxs,
    fontWeight: '800',
    letterSpacing: 1.5,
  },
  streakValue: { color: '#FFF', fontSize: fontSize.xxl, fontWeight: '800' as any },
  streakSub: { color: 'rgba(255,255,255,0.8)', fontSize: fontSize.xs, marginTop: 2 },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  heading: { fontSize: fontSize.lg, fontWeight: '800' as any },
  headingCount: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold as any },
  card: {
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  cardTitle: { flex: 1, fontSize: fontSize.base, fontWeight: fontWeight.semibold as any },
  progressTrack: { height: 8, borderRadius: 4, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 4 },
  progressLabel: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold as any },
  footnote: {
    fontSize: fontSize.xxs,
    textAlign: 'center',
    marginTop: spacing.lg,
    lineHeight: 16,
    paddingHorizontal: spacing.md,
  },
});
