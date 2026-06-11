/**
 * Activity Feed — reason to open the app even without an own match.
 *
 * Three event types from /me/feed (last 7 days, mixed timeline):
 *   - friend_match       → "Lukas hat ein Match gewonnen" + share-link target
 *   - friend_achievement → "Max hat ein Achievement freigeschaltet"
 *   - city_event         → "Neues Turnier in deiner Stadt"
 *
 * Tapping a row deep-links into the relevant detail screen so the feed
 * stays a navigation hub, not a dead end.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  RefreshControl,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../src/providers/ThemeProvider';
import { spacing, fontSize, fontWeight, radius } from '../src/theme/spacing';
import { getActivityFeed, type FeedItem } from '../src/api/v2';

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'gerade eben';
  if (minutes < 60) return `vor ${minutes} Min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `vor ${hours} Std`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `vor ${days} Tg`;
  return new Date(iso).toLocaleDateString('de-DE', { day: 'numeric', month: 'short' });
}

function iconFor(type: FeedItem['type']) {
  switch (type) {
    case 'friend_match':
      return { name: 'tennisball-outline' as const, color: '#4CD964' };
    case 'friend_achievement':
      return { name: 'trophy-outline' as const, color: '#FFD700' };
    case 'city_event':
      return { name: 'megaphone-outline' as const, color: '#8B9DFF' };
  }
}

function describe(item: FeedItem): { title: string; sub: string } {
  switch (item.type) {
    case 'friend_match': {
      const eventTitle = item.payload.event_title as string | null | undefined;
      return {
        title: 'Match abgeschlossen',
        sub: eventTitle ? `${eventTitle}` : 'Ein Freund hat ein Match gespielt',
      };
    }
    case 'friend_achievement': {
      const name = (item.payload.name as string) || 'Ein Freund';
      const ach = item.payload.achievement as string;
      return { title: `${name} freigeschaltet`, sub: ach };
    }
    case 'city_event': {
      const title = (item.payload.title as string) || 'Neues Turnier';
      const start = item.payload.start_date as string | undefined;
      const when = start
        ? new Date(start).toLocaleDateString('de-DE', {
            weekday: 'short',
            day: 'numeric',
            month: 'short',
          })
        : '';
      return { title, sub: when ? `Neu in deiner Stadt · ${when}` : 'Neu in deiner Stadt' };
    }
  }
}

export default function FeedScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const [items, setItems] = useState<FeedItem[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await getActivityFeed();
      setItems(data);
    } catch (err: any) {
      setError(err?.response?.data?.error?.message || 'Feed konnte nicht geladen werden.');
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

  const onItemPress = (item: FeedItem) => {
    if (item.type === 'friend_match' && item.payload.match_id) {
      router.push(`/event/recap/${item.payload.match_id}` as any);
    } else if (item.type === 'friend_achievement' && item.payload.user_id) {
      router.push(`/profile/${item.payload.user_id}` as any);
    } else if (item.type === 'city_event' && item.payload.event_id) {
      router.push(`/event/${item.payload.event_id}` as any);
    }
  };

  if (items === null) {
    return (
      <View style={[styles.loader, { backgroundColor: colors.bg }]}>
        <Stack.Screen options={{ title: 'Aktivität', headerShown: true }} />
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <Stack.Screen options={{ title: 'Aktivität', headerShown: true }} />
      <FlatList
        data={items}
        keyExtractor={(item, idx) => `${item.type}-${item.ts}-${idx}`}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        }
        renderItem={({ item }) => {
          const icon = iconFor(item.type);
          const text = describe(item);
          return (
            <TouchableOpacity
              style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.cardBorder }]}
              onPress={() => onItemPress(item)}
              activeOpacity={0.85}
            >
              <View style={[styles.iconWrap, { backgroundColor: icon.color + '22' }]}>
                <Ionicons name={icon.name} size={20} color={icon.color} />
              </View>
              <View style={styles.rowBody}>
                <Text style={[styles.rowTitle, { color: colors.textPrimary }]} numberOfLines={2}>
                  {text.title}
                </Text>
                <Text style={[styles.rowSub, { color: colors.textTertiary }]} numberOfLines={1}>
                  {text.sub}
                </Text>
              </View>
              <Text style={[styles.ago, { color: colors.textTertiary }]}>{timeAgo(item.ts)}</Text>
            </TouchableOpacity>
          );
        }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="newspaper-outline" size={56} color={colors.textTertiary} />
            <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>
              {error ? 'Feed nicht verfügbar' : 'Noch nichts los'}
            </Text>
            <Text style={[styles.emptyText, { color: colors.textTertiary }]}>
              {error ??
                'Spiele ein Match oder verbinde dich mit Freunden — dann erscheint hier was.'}
            </Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  loader: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  list: { padding: spacing.lg, gap: spacing.sm, paddingBottom: 100 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
  },
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowBody: { flex: 1, gap: 2 },
  rowTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold as any },
  rowSub: { fontSize: fontSize.xs },
  ago: { fontSize: fontSize.xxs },
  empty: { alignItems: 'center', padding: spacing.xxl, gap: spacing.sm },
  emptyTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.semibold as any },
  emptyText: { fontSize: fontSize.sm, textAlign: 'center' },
});
