/**
 * CityLeaderboardScreen — public ranking per sport (and optionally per city).
 *
 * Uses the new backend `/leaderboard` endpoint, which only surfaces
 * discoverable players with at least one rated match — the board feels
 * "real" instead of being dominated by untouched default-ELO accounts.
 *
 * Filter UI:
 *   - Sport: Padel / FIFA (segmented)
 *   - City: free-text, debounced; clear button resets to global
 *
 * Sticky footer shows the viewer's own rank when logged in.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  RefreshControl,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useTheme } from '../src/providers/ThemeProvider';
import { spacing, fontSize, fontWeight, radius } from '../src/theme/spacing';
import { getCityLeaderboard, type LeaderboardCityEntry } from '../src/api/v2';
import { useAuthStore } from '../src/store/authStore';

type Sport = 'padel' | 'fifa';

const SEARCH_DEBOUNCE_MS = 400;

const TIER_COLORS: Record<string, string> = {
  bronze: '#CD7F32',
  silver: '#C0C0C0',
  gold: '#FFD700',
  platinum: '#E5E4E2',
  diamond: '#B9F2FF',
  elite: '#FF6B9D',
};

export default function CityLeaderboardScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { isAuthenticated } = useAuthStore();

  const [sport, setSport] = useState<Sport>('padel');
  const [cityInput, setCityInput] = useState('');
  const [city, setCity] = useState<string>(''); // debounced
  const [entries, setEntries] = useState<LeaderboardCityEntry[]>([]);
  const [myRank, setMyRank] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Debounce city input → reflect into `city` after 400 ms idle.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setCity(cityInput.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [cityInput]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await getCityLeaderboard({
        sport,
        city: city || undefined,
        limit: 50,
      });
      setEntries(data.entries);
      setMyRank(data.my_rank);
    } catch (err: any) {
      setError(err?.response?.data?.error?.message || 'Rangliste konnte nicht geladen werden.');
    } finally {
      setLoading(false);
    }
  }, [sport, city]);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const switchSport = (next: Sport) => {
    if (next === sport) return;
    Haptics.selectionAsync().catch(() => {});
    setLoading(true);
    setSport(next);
  };

  const podium = useMemo(() => entries.slice(0, 3), [entries]);
  const rest = useMemo(() => entries.slice(3), [entries]);

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <Stack.Screen options={{ title: 'Stadt-Rangliste', headerShown: true }} />

      <View style={[styles.filterCard, { backgroundColor: colors.surface, borderColor: colors.cardBorder }]}>
        <View style={styles.sportTabs}>
          {(['padel', 'fifa'] as const).map((s) => {
            const active = s === sport;
            return (
              <TouchableOpacity
                key={s}
                style={[
                  styles.sportTab,
                  {
                    backgroundColor: active ? colors.primary : 'transparent',
                  },
                ]}
                onPress={() => switchSport(s)}
              >
                <Text
                  style={[
                    styles.sportTabText,
                    { color: active ? '#FFF' : colors.textPrimary },
                  ]}
                >
                  {s === 'padel' ? '🏸 Padel' : '🎮 FIFA'}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <View style={[styles.cityInputWrap, { borderColor: colors.cardBorder }]}>
          <Ionicons name="location-outline" size={18} color={colors.textTertiary} />
          <TextInput
            value={cityInput}
            onChangeText={setCityInput}
            placeholder="Stadt eingeben (z. B. München) — leer = global"
            placeholderTextColor={colors.textTertiary}
            style={[styles.cityInput, { color: colors.textPrimary }]}
            autoCapitalize="words"
            autoCorrect={false}
            returnKeyType="search"
          />
          {cityInput.length > 0 && (
            <TouchableOpacity onPress={() => setCityInput('')}>
              <Ionicons name="close-circle" size={18} color={colors.textTertiary} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {loading && entries.length === 0 ? (
        <View style={styles.loader}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : (
        <FlatList
          data={rest}
          keyExtractor={(item) => `${item.user_id}`}
          ListHeaderComponent={
            <View>
              {podium.length > 0 && <PodiumRow entries={podium} colors={colors} onTap={(id) => router.push(`/profile/${id}` as any)} />}
              {error && (
                <Text style={[styles.errorText, { color: colors.error }]}>{error}</Text>
              )}
              {entries.length === 0 && !error && (
                <View style={styles.empty}>
                  <Ionicons name="trophy-outline" size={48} color={colors.textTertiary} />
                  <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>
                    Noch keine Einträge
                  </Text>
                  <Text style={[styles.emptyText, { color: colors.textTertiary }]}>
                    {city
                      ? `In "${city}" hat noch niemand gerankt gespielt.`
                      : 'Spiele dein erstes gewertetes Match, um auf die Liste zu kommen.'}
                  </Text>
                </View>
              )}
            </View>
          }
          renderItem={({ item }) => (
            <RankRow
              entry={item}
              colors={colors}
              onPress={() => router.push(`/profile/${item.user_id}` as any)}
            />
          )}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
          }
        />
      )}

      {isAuthenticated && myRank !== null && (
        <View
          style={[
            styles.myRank,
            {
              backgroundColor: colors.primary + 'EE',
              paddingBottom: Platform.OS === 'ios' ? 34 : spacing.md,
            },
          ]}
        >
          <Text style={styles.myRankLabel}>Dein Rang</Text>
          <Text style={styles.myRankValue}>#{myRank}</Text>
        </View>
      )}
    </View>
  );
}

function PodiumRow({
  entries,
  colors,
  onTap,
}: {
  entries: LeaderboardCityEntry[];
  colors: ReturnType<typeof useTheme>['colors'];
  onTap: (userId: number) => void;
}) {
  const [first, second, third] = [entries[0], entries[1], entries[2]];
  const renderSlot = (entry: LeaderboardCityEntry | undefined, place: 1 | 2 | 3) => {
    if (!entry) return <View style={styles.podiumSlot} />;
    const podiumColor = ['#FFD700', '#C0C0C0', '#CD7F32'][place - 1];
    const height = place === 1 ? 110 : place === 2 ? 86 : 70;
    return (
      <TouchableOpacity
        style={styles.podiumSlot}
        onPress={() => onTap(entry.user_id)}
        activeOpacity={0.85}
      >
        <Text
          style={[styles.podiumName, { color: colors.textPrimary }]}
          numberOfLines={1}
        >
          {entry.name}
        </Text>
        <Text style={[styles.podiumElo, { color: podiumColor }]}>{entry.elo}</Text>
        <View
          style={[
            styles.podiumBlock,
            {
              height,
              backgroundColor: podiumColor + '22',
              borderColor: podiumColor,
            },
          ]}
        >
          <Text style={[styles.podiumPlace, { color: podiumColor }]}>{place}</Text>
        </View>
      </TouchableOpacity>
    );
  };
  return (
    <View style={styles.podium}>
      {renderSlot(second, 2)}
      {renderSlot(first, 1)}
      {renderSlot(third, 3)}
    </View>
  );
}

function RankRow({
  entry,
  colors,
  onPress,
}: {
  entry: LeaderboardCityEntry;
  colors: ReturnType<typeof useTheme>['colors'];
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.85}
      style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.cardBorder }]}
    >
      <Text style={[styles.rowRank, { color: colors.textTertiary }]}>#{entry.rank}</Text>
      <View style={styles.rowMid}>
        <Text style={[styles.rowName, { color: colors.textPrimary }]} numberOfLines={1}>
          {entry.name}
        </Text>
        {entry.city && (
          <Text style={[styles.rowCity, { color: colors.textTertiary }]} numberOfLines={1}>
            {entry.city} · {entry.matches_played} Spiele
          </Text>
        )}
      </View>
      <View style={[styles.tierBadge, { backgroundColor: (TIER_COLORS[entry.tier] || '#888') + '22' }]}>
        <Text style={[styles.tierText, { color: TIER_COLORS[entry.tier] || '#888' }]}>
          {entry.tier}
        </Text>
      </View>
      <Text style={[styles.rowElo, { color: colors.primary }]}>{entry.elo}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  loader: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  filterCard: {
    margin: spacing.lg,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing.md,
  },
  sportTabs: { flexDirection: 'row', gap: spacing.sm },
  sportTab: {
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  sportTabText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold as any },
  cityInputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  cityInput: { flex: 1, fontSize: fontSize.sm, paddingVertical: spacing.xs },
  listContent: { paddingHorizontal: spacing.lg, paddingBottom: 120, gap: spacing.xs },
  podium: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'center',
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  podiumSlot: { flex: 1, alignItems: 'center', gap: 4 },
  podiumName: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold as any, textAlign: 'center' },
  podiumElo: { fontSize: fontSize.lg, fontWeight: '800' as any },
  podiumBlock: {
    width: '100%',
    borderTopLeftRadius: radius.md,
    borderTopRightRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.xs,
  },
  podiumPlace: { fontSize: 28, fontWeight: '800' as any },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    gap: spacing.sm,
  },
  rowRank: { width: 36, fontSize: fontSize.sm, fontWeight: fontWeight.semibold as any },
  rowMid: { flex: 1 },
  rowName: { fontSize: fontSize.base, fontWeight: fontWeight.semibold as any },
  rowCity: { fontSize: fontSize.xxs, marginTop: 2 },
  tierBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },
  tierText: {
    fontSize: 10,
    fontWeight: fontWeight.bold as any,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  rowElo: { width: 56, fontSize: fontSize.base, fontWeight: '800' as any, textAlign: 'right' },
  empty: { alignItems: 'center', padding: spacing.xxl, gap: spacing.sm },
  emptyTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.semibold as any },
  emptyText: { fontSize: fontSize.sm, textAlign: 'center' },
  errorText: { fontSize: fontSize.sm, textAlign: 'center', marginBottom: spacing.md },
  myRank: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  myRankLabel: {
    color: '#FFF',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold as any,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  myRankValue: { color: '#FFF', fontSize: 24, fontWeight: '800' as any },
});
