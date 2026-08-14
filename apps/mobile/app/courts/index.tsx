/**
 * Plätze finden — the entry point to the whole court-booking pillar.
 *
 * This screen did not exist before, which is why "Courts" on the home tab
 * and "Plätze" under Spielen both pointed at the tournaments tab: venue
 * detail, availability and bookings were an unreachable subgraph. Those
 * links now land here.
 *
 * Location is requested only when the user asks for nearby venues — an
 * unprompted permission dialog on first open is the fastest way to get it
 * denied permanently.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as Location from 'expo-location';
import { useTheme } from '../../src/providers/ThemeProvider';
import { spacing, fontSize, fontWeight, radius } from '../../src/theme/spacing';
import { useVenueStore, type Venue } from '../../src/store/venueStore';
import { useToast } from '../../src/components/common';

const SEARCH_DEBOUNCE_MS = 350;
const DEFAULT_RADIUS_KM = 25;

export default function CourtsScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const showToast = useToast((s) => s.show);

  const { venues, loading, error, geoActive, fetchVenues, setFilters, clearFilters } =
    useVenueStore();

  const [search, setSearch] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [locating, setLocating] = useState(false);

  useEffect(() => {
    fetchVenues();
  }, [fetchVenues]);

  // Debounced so a five-letter city name is one request, not five.
  useEffect(() => {
    const timer = setTimeout(() => {
      setFilters({ search: search.trim() || undefined });
      fetchVenues();
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search, setFilters, fetchVenues]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchVenues();
    setRefreshing(false);
  }, [fetchVenues]);

  const useMyLocation = useCallback(async () => {
    Haptics.selectionAsync().catch(() => {});
    setLocating(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        showToast(
          'info',
          'Standort nicht freigegeben',
          'Du kannst stattdessen nach Stadt suchen.'
        );
        return;
      }
      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      setSearch('');
      setFilters({
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        radius_km: DEFAULT_RADIUS_KM,
        search: undefined,
        city: undefined,
      });
      await fetchVenues();
    } catch {
      showToast('error', 'Standort konnte nicht ermittelt werden');
    } finally {
      setLocating(false);
    }
  }, [setFilters, fetchVenues, showToast]);

  const resetToAll = useCallback(async () => {
    setSearch('');
    clearFilters();
    await fetchVenues();
  }, [clearFilters, fetchVenues]);

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <Stack.Screen options={{ title: 'Plätze finden', headerShown: true }} />

      <View style={styles.controls}>
        <View
          style={[
            styles.searchBox,
            { backgroundColor: colors.surface, borderColor: colors.cardBorder },
          ]}
        >
          <Ionicons name="search" size={18} color={colors.textTertiary as string} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Stadt oder Halle suchen"
            placeholderTextColor={colors.textTertiary as string}
            style={[styles.searchInput, { color: colors.textPrimary }]}
            autoCorrect={false}
            returnKeyType="search"
            accessibilityLabel="Nach Stadt oder Halle suchen"
          />
          {search.length > 0 && (
            <TouchableOpacity onPress={() => setSearch('')} accessibilityLabel="Suche leeren">
              <Ionicons name="close-circle" size={18} color={colors.textTertiary as string} />
            </TouchableOpacity>
          )}
        </View>

        <TouchableOpacity
          onPress={geoActive ? resetToAll : useMyLocation}
          disabled={locating}
          style={[
            styles.geoBtn,
            {
              backgroundColor: geoActive ? (colors.primary as string) : colors.surface,
              borderColor: geoActive ? (colors.primary as string) : colors.cardBorder,
            },
          ]}
          accessibilityRole="button"
          accessibilityLabel={geoActive ? 'Alle Hallen zeigen' : 'Hallen in meiner Nähe'}
        >
          {locating ? (
            <ActivityIndicator size="small" color={geoActive ? '#FFF' : colors.primary} />
          ) : (
            <Ionicons
              name={geoActive ? 'close' : 'navigate'}
              size={18}
              color={geoActive ? '#FFF' : (colors.primary as string)}
            />
          )}
        </TouchableOpacity>
      </View>

      {geoActive && (
        <Text style={[styles.geoHint, { color: colors.textTertiary }]}>
          Hallen im Umkreis von {DEFAULT_RADIUS_KM} km
        </Text>
      )}

      {loading && venues.length === 0 ? (
        <View style={styles.loader}>
          <ActivityIndicator color={colors.primary as string} />
        </View>
      ) : (
        <FlatList
          data={venues}
          keyExtractor={(venue) => String(venue.id)}
          renderItem={({ item }) => (
            <VenueRow
              venue={item}
              colors={colors}
              onPress={() => router.push(`/venue/${item.id}` as never)}
              onAvailability={() =>
                router.push(`/venue/availability/${item.id}` as never)
              }
            />
          )}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.primary as string}
            />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="location-outline" size={52} color={colors.textTertiary as string} />
              <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>
                {error ? 'Hallen konnten nicht geladen werden' : 'Keine Hallen gefunden'}
              </Text>
              <Text style={[styles.emptyText, { color: colors.textTertiary }]}>
                {error
                  ? 'Bitte prüfe deine Verbindung und versuche es erneut.'
                  : search
                    ? 'Versuche es mit einer anderen Stadt.'
                    : 'Bald sind hier Hallen in deiner Nähe.'}
              </Text>
              <TouchableOpacity
                style={[styles.retryBtn, { backgroundColor: colors.primary as string }]}
                onPress={resetToAll}
              >
                <Text style={styles.retryText}>{error ? 'Erneut versuchen' : 'Alle anzeigen'}</Text>
              </TouchableOpacity>
            </View>
          }
        />
      )}
    </View>
  );
}

function VenueRow({
  venue,
  colors,
  onPress,
  onAvailability,
}: {
  venue: Venue;
  colors: any;
  onPress: () => void;
  onAvailability: () => void;
}) {
  const courtCount = venue.courts?.length ?? 0;

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.85}
      style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.cardBorder }]}
      accessibilityRole="button"
      accessibilityLabel={`${venue.name}, ${venue.address_city}`}
    >
      <View style={styles.cardBody}>
        <Text style={[styles.venueName, { color: colors.textPrimary }]} numberOfLines={1}>
          {venue.name}
        </Text>
        <Text style={[styles.venueMeta, { color: colors.textTertiary }]} numberOfLines={1}>
          {venue.address_city}
          {venue.distance_km != null ? ` · ${venue.distance_km} km` : ''}
          {courtCount > 0 ? ` · ${courtCount} ${courtCount === 1 ? 'Platz' : 'Plätze'}` : ''}
        </Text>
      </View>

      <TouchableOpacity
        onPress={onAvailability}
        style={[styles.availBtn, { backgroundColor: colors.primary as string }]}
        accessibilityRole="button"
        accessibilityLabel={`Verfügbarkeit bei ${venue.name} ansehen`}
      >
        <Text style={styles.availText}>Zeiten</Text>
      </TouchableOpacity>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  loader: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  controls: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    height: 44,
  },
  searchInput: { flex: 1, fontSize: fontSize.base, padding: 0 },
  geoBtn: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  geoHint: { fontSize: fontSize.xs, paddingHorizontal: spacing.lg, paddingTop: spacing.xs },
  listContent: { padding: spacing.lg, gap: spacing.sm, paddingBottom: 120 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
  },
  cardBody: { flex: 1, gap: 2 },
  venueName: { fontSize: fontSize.base, fontWeight: fontWeight.semibold as any },
  venueMeta: { fontSize: fontSize.xs },
  availBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
  },
  availText: { color: '#FFF', fontSize: fontSize.xs, fontWeight: fontWeight.semibold as any },
  empty: { alignItems: 'center', paddingTop: 80, paddingHorizontal: spacing.xl, gap: spacing.sm },
  emptyTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.bold as any, textAlign: 'center' },
  emptyText: { fontSize: fontSize.sm, textAlign: 'center', lineHeight: 20 },
  retryBtn: {
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
  },
  retryText: { color: '#FFF', fontSize: fontSize.sm, fontWeight: fontWeight.semibold as any },
});
