/**
 * Spielen Screen – Tourneo
 * Sport categories, open matches from API, nearby venues from venueStore
 */
import React, { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  Dimensions, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../src/providers/ThemeProvider';
import type { Colors } from '../../src/theme/colors';
import { useVenueStore, type Venue } from '../../src/store/venueStore';
import { useEventStore, type Event } from '../../src/store/eventStore';
import { TLoadingScreen, TEmptyState } from '../../src/components/common';
import { spacing, fontSize, fontWeight, radius, shadow } from '../../src/theme/spacing';

// expo-location is loaded lazily so we don't crash if the native module is
// not yet linked (e.g. in expo go without the plugin reload).
let LocationModule: typeof import('expo-location') | null = null;
async function loadLocation() {
  if (LocationModule) return LocationModule;
  try {
    LocationModule = await import('expo-location');
    return LocationModule;
  } catch {
    return null;
  }
}

const { width: SCREEN_WIDTH } = Dimensions.get('window');

// ─── Sport Categories ────────────────────────────────────────
interface SportCategory {
  id: string;
  title: string;
  subtitle: string;
  icon: string;
  gradient: [string, string];
  available: boolean;
  comingSoon?: boolean;
}

// ─── Sport Card Component ────────────────────────────────────
const SportCard = React.memo(function SportCard({
  sport, colors, onPress,
}: {
  sport: SportCategory; colors: Colors; onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.sportCard, {
        backgroundColor: colors.cardBg, borderColor: colors.cardBorder,
        shadowColor: colors.shadowColor, shadowOpacity: colors.cardShadowOpacity,
      }]}
      activeOpacity={sport.available ? 0.7 : 1}
      onPress={sport.available ? onPress : undefined}
    >
      <View style={[styles.sportIconContainer, { backgroundColor: sport.gradient[0] + '18' }]}>
        <Text style={styles.sportIcon}>{sport.icon}</Text>
      </View>
      <View style={styles.sportInfo}>
        <View style={styles.sportTitleRow}>
          <Text style={[styles.sportTitle, { color: colors.textPrimary }]}>{sport.title}</Text>
          {sport.comingSoon && (
            <View style={[styles.comingSoonBadge, { backgroundColor: colors.accentLight }]}>
              <Text style={[styles.comingSoonText, { color: colors.accent }]}>Bald</Text>
            </View>
          )}
        </View>
        <Text style={[styles.sportSubtitle, { color: colors.textSecondary }]}>{sport.subtitle}</Text>
      </View>
      <Text style={[styles.sportArrow, { color: sport.available ? colors.primary : colors.textTertiary }]}>›</Text>
    </TouchableOpacity>
  );
});

// ─── Quick Match Card (from real events) ─────────────────────
const QuickMatchCard = React.memo(function QuickMatchCard({
  event, colors, onPress,
}: {
  event: Event; colors: Colors; onPress: () => void;
}) {
  const spotsLeft = event.spots_remaining ?? (event.max_participants - event.participant_count);
  const dateStr = event.start_date ? new Date(event.start_date).toLocaleDateString('de-DE', {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  }) : '';
  const sportIcon = event.sport_category === 'fifa' ? '🎮' : '🏸';

  return (
    <TouchableOpacity
      style={[styles.quickMatchCard, {
        backgroundColor: colors.cardBg, borderColor: colors.cardBorder,
        shadowColor: colors.shadowColor, shadowOpacity: colors.cardShadowOpacity,
      }]}
      activeOpacity={0.7}
      onPress={onPress}
    >
      <View style={styles.quickMatchHeader}>
        <Text style={styles.quickMatchIcon}>{sportIcon}</Text>
        <View style={[styles.quickMatchPlayerBadge, { backgroundColor: colors.primaryLight }]}>
          <Text style={[styles.quickMatchPlayerText, { color: colors.primary }]}>
            {event.participant_count}/{event.max_participants}
          </Text>
        </View>
      </View>
      <Text style={[styles.quickMatchTitle, { color: colors.textPrimary }]} numberOfLines={1}>{event.title}</Text>
      <Text style={[styles.quickMatchTime, { color: colors.textSecondary }]}>{dateStr}</Text>
      <View style={[styles.quickMatchLevelBadge, { backgroundColor: colors.surfaceSecondary }]}>
        <Text style={[styles.quickMatchLevelText, { color: colors.textSecondary }]}>
          {spotsLeft > 0 ? `${spotsLeft} Plätze frei` : 'Warteliste'}
        </Text>
      </View>
    </TouchableOpacity>
  );
});

// ─── Venue Card Component ────────────────────────────────────
const VenueCard = React.memo(function VenueCard({
  venue, colors, onPress,
}: {
  venue: Venue; colors: Colors; onPress: () => void;
}) {
  const courtCount = venue.courts?.length ?? 0;
  const distance =
    venue.distance_km !== undefined && venue.distance_km !== null
      ? `${venue.distance_km.toFixed(1).replace('.', ',')} km entfernt`
      : null;

  return (
    <TouchableOpacity
      style={[styles.venueCard, {
        backgroundColor: colors.cardBg, borderColor: colors.cardBorder,
        shadowColor: colors.shadowColor, shadowOpacity: colors.cardShadowOpacity,
      }]}
      activeOpacity={0.7}
      onPress={onPress}
    >
      <View style={[styles.venueImage, { backgroundColor: colors.surfaceSecondary }]}>
        <Text style={styles.venueImagePlaceholder}>🏟️</Text>
      </View>
      <View style={styles.venueInfo}>
        <Text style={[styles.venueName, { color: colors.textPrimary }]} numberOfLines={1}>{venue.name}</Text>
        <View style={styles.venueDetails}>
          <Text style={[styles.venueDetailText, { color: colors.textSecondary }]}>📍 {venue.address_city}</Text>
          {courtCount > 0 && (
            <>
              <Text style={[styles.venueDetailDot, { color: colors.textTertiary }]}>·</Text>
              <Text style={[styles.venueDetailText, { color: colors.textSecondary }]}>{courtCount} Plätze</Text>
            </>
          )}
          {distance && (
            <>
              <Text style={[styles.venueDetailDot, { color: colors.textTertiary }]}>·</Text>
              <Text style={[styles.venueDetailText, { color: colors.primary }]}>{distance}</Text>
            </>
          )}
        </View>
      </View>
      <Text style={[styles.venueArrow, { color: colors.primary }]}>›</Text>
    </TouchableOpacity>
  );
});

// ─── Main Spielen Screen ─────────────────────────────────────
export default function SpielenScreen() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);

  // Real data from stores
  const { venues, fetchVenues, loading: venuesLoading, geoActive, setFilters, clearFilters } =
    useVenueStore();
  const { events, fetchEvents, loading: eventsLoading } = useEventStore();

  /**
   * Tries to obtain the user location and triggers a geo-search.
   * Falls back to the default city-based search when the permission
   * is denied or the location lookup fails.
   */
  const fetchVenuesWithLocation = async () => {
    const Location = await loadLocation();
    if (!Location) {
      await fetchVenues();
      return;
    }
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        clearFilters();
        await fetchVenues();
        return;
      }
      const loc = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      setFilters({
        lat: loc.coords.latitude,
        lng: loc.coords.longitude,
        radius_km: 25,
      });
      await fetchVenues();
    } catch {
      clearFilters();
      await fetchVenues();
    }
  };

  useEffect(() => {
    fetchVenuesWithLocation();
    fetchEvents();
  }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([fetchVenuesWithLocation(), fetchEvents()]);
    setRefreshing(false);
  };

  // Filter open events (upcoming, with spots)
  const openMatches = events
    .filter((e) => {
      const startDate = e.start_date ? new Date(e.start_date) : null;
      return startDate && startDate > new Date() && e.status === 'published';
    })
    .sort((a, b) => new Date(a.start_date!).getTime() - new Date(b.start_date!).getTime())
    .slice(0, 6);

  const sportCategories: SportCategory[] = [
    {
      id: 'padel',
      title: 'Padel',
      subtitle: t('spielen.padelSubtitle'),
      icon: '🏸',
      gradient: [colors.primary as string, colors.primaryDark as string],
      available: true,
    },
    {
      id: 'fifa',
      title: 'FIFA / eGaming',
      subtitle: t('spielen.fifaSubtitle'),
      icon: '🎮',
      gradient: ['#F97316', '#EA580C'],
      available: true,
    },
    {
      id: 'freies-spiel',
      title: t('spielen.freePlay'),
      subtitle: t('spielen.freePlaySubtitle'),
      icon: '🎯',
      gradient: ['#7C3AED', '#5B21B6'],
      available: true,
    },
    {
      id: 'plaetze',
      title: t('spielen.findCourts'),
      subtitle: t('spielen.findCourtsSubtitle'),
      icon: '📍',
      gradient: ['#2563EB', '#1D4ED8'],
      available: true,
    },
  ];

  const handleSportPress = (sportId: string) => {
    if (sportId === 'padel' || sportId === 'fifa') {
      router.push({ pathname: '/matchmaking', params: { sport: sportId } });
    } else if (sportId === 'freies-spiel') {
      router.push('/matchmaking');
    } else if (sportId === 'plaetze') {
      router.push('/courts');
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.bg }]} edges={['top']}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary as string} />
        }
      >
        {/* Header */}
        <View style={styles.header}>
          <Text style={[styles.headerTitle, { color: colors.textPrimary }]}>{t('spielen.title')}</Text>
          <Text style={[styles.headerSubtitle, { color: colors.textSecondary }]}>
            {t('spielen.subtitle')}
          </Text>
        </View>

        {/* Sport Categories */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>{t('spielen.sports')}</Text>
          <View style={styles.sportList}>
            {sportCategories.map((sport) => (
              <SportCard
                key={sport.id}
                sport={sport}
                colors={colors}
                onPress={() => handleSportPress(sport.id)}
              />
            ))}
          </View>
        </View>

        {/* Open Matches (from real events) */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>{t('spielen.openMatches')}</Text>
            <TouchableOpacity onPress={() => router.push('/(tabs)/turniere')}>
              <Text style={[styles.sectionLink, { color: colors.primary }]}>{t('common.viewAll')} →</Text>
            </TouchableOpacity>
          </View>
          {eventsLoading && openMatches.length === 0 ? (
            <View style={styles.loadingRow}>
              <Text style={{ color: colors.textTertiary }}>{t('common.loading')}...</Text>
            </View>
          ) : openMatches.length === 0 ? (
            <View style={styles.emptyRow}>
              <Text style={{ color: colors.textTertiary, textAlign: 'center' }}>{t('spielen.noOpenMatches')}</Text>
            </View>
          ) : (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.horizontalScroll}
            >
              {openMatches.map((event) => (
                <QuickMatchCard
                  key={event.id}
                  event={event}
                  colors={colors}
                  onPress={() => router.push(`/event/${event.id}`)}
                />
              ))}
            </ScrollView>
          )}
        </View>

        {/* Nearby Venues (from real API) */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>{t('spielen.nearbyVenues')}</Text>
          </View>
          {venuesLoading && venues.length === 0 ? (
            <View style={styles.loadingRow}>
              <Text style={{ color: colors.textTertiary }}>{t('common.loading')}...</Text>
            </View>
          ) : venues.length === 0 ? (
            <TEmptyState
              title={t('spielen.noVenuesTitle')}
              message={t('spielen.noVenuesDescription')}
              icon="📍"
            />
          ) : (
            <View style={styles.venueList}>
              {venues.slice(0, 5).map((venue) => (
                <VenueCard
                  key={venue.id}
                  venue={venue}
                  colors={colors}
                  onPress={() => router.push(`/venue/${venue.id}`)}
                />
              ))}
            </View>
          )}
        </View>

        {/* CTA Banner */}
        <TouchableOpacity
          style={[styles.ctaBanner, { backgroundColor: colors.primary }]}
          activeOpacity={0.85}
          onPress={() => router.push('/(tabs)/turniere')}
        >
          <View style={styles.ctaContent}>
            <Text style={styles.ctaIcon}>🏆</Text>
            <View style={styles.ctaTextContainer}>
              <Text style={styles.ctaTitle}>{t('spielen.createTournament')}</Text>
              <Text style={styles.ctaSubtitle}>{t('spielen.createTournamentDesc')}</Text>
            </View>
          </View>
          <Text style={styles.ctaArrow}>→</Text>
        </TouchableOpacity>

        <View style={{ height: 100 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Styles ──────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1 },
  scrollView: { flex: 1 },
  scrollContent: { paddingHorizontal: spacing.lg },
  header: { paddingTop: spacing.lg, paddingBottom: spacing.md },
  headerTitle: { fontSize: 32, fontWeight: fontWeight.bold as '700', letterSpacing: -0.5 },
  headerSubtitle: { fontSize: fontSize.md, marginTop: spacing.xs, lineHeight: 22 },
  section: { marginTop: spacing.xl },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.md },
  sectionTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.semibold as '600', letterSpacing: -0.3 },
  sectionLink: { fontSize: fontSize.sm, fontWeight: fontWeight.medium as '500' },
  loadingRow: { paddingVertical: spacing.xl, alignItems: 'center' },
  emptyRow: { paddingVertical: spacing.xl, alignItems: 'center' },

  // Sport Cards
  sportList: { gap: spacing.sm, marginTop: spacing.sm },
  sportCard: {
    flexDirection: 'row', alignItems: 'center', padding: spacing.md,
    borderRadius: radius.lg, borderWidth: 1, ...shadow.sm,
  },
  sportIconContainer: { width: 52, height: 52, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  sportIcon: { fontSize: 26 },
  sportInfo: { flex: 1, marginLeft: spacing.md },
  sportTitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  sportTitle: { fontSize: fontSize.md, fontWeight: fontWeight.semibold as '600' },
  sportSubtitle: { fontSize: fontSize.sm, marginTop: 2, lineHeight: 18 },
  sportArrow: { fontSize: 24, fontWeight: fontWeight.light as '300', marginLeft: spacing.sm },
  comingSoonBadge: { paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.full },
  comingSoonText: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold as '600' },

  // Quick Match Cards
  horizontalScroll: { paddingRight: spacing.lg, gap: spacing.sm },
  quickMatchCard: {
    width: 170, padding: spacing.md, borderRadius: radius.lg, borderWidth: 1, ...shadow.sm,
  },
  quickMatchHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.sm },
  quickMatchIcon: { fontSize: 28 },
  quickMatchPlayerBadge: { paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.full },
  quickMatchPlayerText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold as '700' },
  quickMatchTitle: { fontSize: fontSize.md, fontWeight: fontWeight.semibold as '600', marginBottom: 4 },
  quickMatchTime: { fontSize: fontSize.xs, marginBottom: spacing.sm },
  quickMatchLevelBadge: { alignSelf: 'flex-start', paddingHorizontal: spacing.sm, paddingVertical: 3, borderRadius: radius.sm },
  quickMatchLevelText: { fontSize: fontSize.xs, fontWeight: fontWeight.medium as '500' },

  // Venue Cards
  venueList: { gap: spacing.sm },
  venueCard: {
    flexDirection: 'row', alignItems: 'center', padding: spacing.sm,
    borderRadius: radius.lg, borderWidth: 1, ...shadow.sm,
  },
  venueImage: { width: 56, height: 56, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  venueImagePlaceholder: { fontSize: 24 },
  venueInfo: { flex: 1, marginLeft: spacing.md },
  venueName: { fontSize: fontSize.md, fontWeight: fontWeight.semibold as '600', marginBottom: 4 },
  venueDetails: { flexDirection: 'row', alignItems: 'center' },
  venueDetailText: { fontSize: fontSize.xs },
  venueDetailDot: { marginHorizontal: 6, fontSize: fontSize.xs },
  venueArrow: { fontSize: 22, fontWeight: fontWeight.light as '300', marginLeft: spacing.sm },

  // CTA Banner
  ctaBanner: {
    marginTop: spacing.xl, borderRadius: radius.lg, padding: spacing.lg,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  ctaContent: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  ctaIcon: { fontSize: 32, marginRight: spacing.md },
  ctaTextContainer: { flex: 1 },
  ctaTitle: { color: '#FFFFFF', fontSize: fontSize.md, fontWeight: fontWeight.bold as '700' },
  ctaSubtitle: { color: 'rgba(255,255,255,0.85)', fontSize: fontSize.xs, marginTop: 2, lineHeight: 16 },
  ctaArrow: { color: '#FFFFFF', fontSize: 22, fontWeight: fontWeight.bold as '700', marginLeft: spacing.sm },
});