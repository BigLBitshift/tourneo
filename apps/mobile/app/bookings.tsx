/**
 * MyBookingsScreen – list of the user's court bookings.
 *
 * Upcoming bookings on top, past ones collapsed below. Cancellation is
 * blocked client-side for slots within 2h of start (matches the backend
 * rule) and server-side as the source of truth.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  RefreshControl,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useTheme } from '../src/providers/ThemeProvider';
import { spacing, fontSize, fontWeight, radius } from '../src/theme/spacing';
import { useBookingStore } from '../src/store/bookingStore';
import { useToast } from '../src/components/common';
import { getMyQueue, type CourtBooking, type MyQueueEntry } from '../src/api/v2';
import { useTopic } from '../src/realtime/RealtimeProvider';
import { useAuthStore } from '../src/store/authStore';

const CANCEL_CUTOFF_MS = 2 * 60 * 60 * 1000;

function startTimeOf(b: CourtBooking): Date {
  // slot_date may arrive as ISO with time or as YYYY-MM-DD; we only need
  // the date prefix and combine with slot_start.
  const date = String(b.slot_date).slice(0, 10);
  return new Date(`${date}T${b.slot_start}`);
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short' });
}

function formatTime(t: string): string {
  return t.slice(0, 5);
}

export default function MyBookingsScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { bookings, loading, error, fetchMine, cancel } = useBookingStore();
  const showToast = useToast((s) => s.show);
  const [refreshing, setRefreshing] = useState(false);
  const [cancellingId, setCancellingId] = useState<number | null>(null);

  /** Queue entries and live offers, shown above the bookings themselves. */
  const [queue, setQueue] = useState<{ queued: MyQueueEntry[]; offers: MyQueueEntry[] }>({
    queued: [],
    offers: [],
  });
  const userId = useAuthStore((s) => s.user?.id);

  const loadQueue = useCallback(async () => {
    try {
      setQueue(await getMyQueue());
    } catch {
      // A queue that fails to load must not break the bookings list.
    }
  }, []);

  useEffect(() => {
    fetchMine();
  }, [fetchMine]);

  // The screen was mount-only before, so a booking made elsewhere never
  // appeared until the app restarted.
  useFocusEffect(
    useCallback(() => {
      fetchMine();
      loadQueue();
    }, [fetchMine, loadQueue])
  );

  // Position changes and new offers arrive live while the screen is open.
  useTopic(userId ? `user:${userId}` : null, (event) => {
    if (
      event.event === 'offer_created' ||
      event.event === 'offer_expired' ||
      event.event === 'position_changed'
    ) {
      loadQueue();
    }
  });

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([fetchMine(), loadQueue()]);
    setRefreshing(false);
  }, [fetchMine, loadQueue]);

  const { upcoming, past } = useMemo(() => {
    const now = Date.now();
    const sorted = [...bookings].sort(
      (a, b) => startTimeOf(b).getTime() - startTimeOf(a).getTime()
    );
    return {
      upcoming: sorted
        .filter(
          (b) =>
            (b.status === 'confirmed' || b.status === 'pending_payment') &&
            startTimeOf(b).getTime() >= now
        )
        .reverse(), // soonest first
      past: sorted.filter(
        (b) => b.status === 'cancelled' || startTimeOf(b).getTime() < now
      ),
    };
  }, [bookings]);

  const handleCancel = useCallback(
    (booking: CourtBooking) => {
      const startsAt = startTimeOf(booking);
      if (startsAt.getTime() - Date.now() < CANCEL_CUTOFF_MS) {
        Alert.alert(
          'Stornierung nicht möglich',
          'Du kannst Buchungen nur bis 2 Stunden vor Startzeit stornieren.'
        );
        return;
      }
      Alert.alert(
        'Buchung stornieren?',
        `${formatDate(startsAt)}, ${formatTime(booking.slot_start)} – ${formatTime(booking.slot_end)}`,
        [
          { text: 'Behalten', style: 'cancel' },
          {
            text: 'Stornieren',
            style: 'destructive',
            onPress: async () => {
              try {
                setCancellingId(booking.id);
                await cancel(booking.id);
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
                  () => {}
                );
                showToast('success', 'Buchung storniert');
              } catch (err: any) {
                const msg =
                  err?.response?.data?.error?.message || 'Stornierung fehlgeschlagen.';
                showToast('error', 'Fehler', msg);
              } finally {
                setCancellingId(null);
              }
            },
          },
        ]
      );
    },
    [cancel, showToast]
  );

  const renderBooking = ({ item }: { item: CourtBooking }) => {
    const startsAt = startTimeOf(item);
    const isPast = startsAt.getTime() < Date.now();
    const isCancelled = item.status === 'cancelled';
    const isCancellable =
      !isPast && !isCancelled && startsAt.getTime() - Date.now() >= CANCEL_CUTOFF_MS;
    const dim = isPast || isCancelled;

    return (
      <View
        style={[
          styles.card,
          {
            backgroundColor: colors.surface,
            borderColor: colors.cardBorder,
            opacity: dim ? 0.6 : 1,
          },
        ]}
      >
        <View style={styles.cardRow}>
          <View style={styles.cardLeft}>
            <Text style={[styles.cardDate, { color: colors.textTertiary }]}>
              {formatDate(startsAt)}
            </Text>
            <Text style={[styles.cardTime, { color: colors.textPrimary }]}>
              {formatTime(item.slot_start)} – {formatTime(item.slot_end)}
            </Text>
          </View>
          <View style={styles.cardRight}>
            {item.price_cents != null && (
              <Text style={[styles.cardPrice, { color: colors.primary }]}>
                {(item.price_cents / 100).toFixed(item.price_cents % 100 === 0 ? 0 : 2)} €
              </Text>
            )}
            {isCancelled && (
              <Text style={[styles.cardStatus, { color: colors.error }]}>Storniert</Text>
            )}
            {item.status === 'pending_payment' && (
              <Text style={[styles.cardStatus, { color: colors.warning }]}>
                Zahlung offen
              </Text>
            )}
            {!isCancelled && item.status !== 'pending_payment' && isPast && (
              <Text style={[styles.cardStatus, { color: colors.textTertiary }]}>Vergangen</Text>
            )}
          </View>
        </View>

        <View style={styles.venueRow}>
          <Ionicons name="location-outline" size={14} color={colors.textTertiary} />
          <Text style={[styles.venueText, { color: colors.textSecondary }]} numberOfLines={1}>
            {item.venue_name || '—'}
            {item.court_name ? ` · ${item.court_name}` : ''}
            {item.venue_city ? ` · ${item.venue_city}` : ''}
          </Text>
        </View>

        {isCancellable && (
          <TouchableOpacity
            onPress={() => handleCancel(item)}
            disabled={cancellingId === item.id}
            style={[styles.cancelBtn, { borderColor: colors.error + '88' }]}
          >
            {cancellingId === item.id ? (
              <ActivityIndicator color={colors.error} />
            ) : (
              <Text style={[styles.cancelText, { color: colors.error }]}>Stornieren</Text>
            )}
          </TouchableOpacity>
        )}
      </View>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <Stack.Screen options={{ title: 'Meine Buchungen', headerShown: true }} />

      {loading && bookings.length === 0 ? (
        <View style={styles.loader}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : (
        <FlatList
          data={[
            ...(queue.offers.length
              ? [{ kind: 'header', title: 'Platz für dich reserviert', count: queue.offers.length }]
              : []),
            ...queue.offers.map((q) => ({ kind: 'queue' as const, entry: q })),
            ...(queue.queued.length
              ? [{ kind: 'header', title: 'In der Warteschlange', count: queue.queued.length }]
              : []),
            ...queue.queued.map((q) => ({ kind: 'queue' as const, entry: q })),
            ...(upcoming.length ? [{ kind: 'header', title: 'Anstehend', count: upcoming.length }] : []),
            ...upcoming.map((b) => ({ kind: 'booking' as const, booking: b })),
            ...(past.length ? [{ kind: 'header', title: 'Vergangen', count: past.length }] : []),
            ...past.map((b) => ({ kind: 'booking' as const, booking: b })),
          ] as any[]}
          keyExtractor={(item, idx) =>
            item.kind === 'header'
              ? `h-${idx}-${item.title}`
              : item.kind === 'queue'
                ? `q-${item.entry.entry_id}`
                : `b-${item.booking.id}`
          }
          renderItem={({ item }: { item: any }) =>
            item.kind === 'header' ? (
              <Text style={[styles.sectionHeader, { color: colors.textTertiary }]}>
                {item.title} · {item.count}
              </Text>
            ) : item.kind === 'queue' ? (
              <QueueRow
                entry={item.entry}
                colors={colors}
                onPress={() =>
                  item.entry.offer
                    ? router.push(`/slot/${item.entry.slot_id}/claim` as never)
                    : router.push(`/venue/availability/${item.entry.venue_id}` as never)
                }
              />
            ) : (
              renderBooking({ item: item.booking })
            )
          }
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="calendar-outline" size={56} color={colors.textTertiary} />
              <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>
                Noch keine Buchungen
              </Text>
              <Text style={[styles.emptyText, { color: colors.textTertiary }]}>
                Finde Plätze in deiner Nähe und buche sie direkt in der App.
              </Text>
              <TouchableOpacity
                style={[styles.findBtn, { backgroundColor: colors.primary }]}
                onPress={() => router.push('/(tabs)/spielen')}
              >
                <Text style={styles.findBtnText}>Plätze finden</Text>
              </TouchableOpacity>
            </View>
          }
        />
      )}
      {error && bookings.length === 0 && (
        <Text style={[styles.errorText, { color: colors.error }]}>{error}</Text>
      )}
    </View>
  );
}

/**
 * A queue entry or a live offer.
 *
 * An offer is visually loud on purpose — it has a deadline, and the user
 * losing a court because the row looked like every other row would be the
 * feature's worst failure mode.
 */
function QueueRow({
  entry,
  colors,
  onPress,
}: {
  entry: MyQueueEntry;
  colors: any;
  onPress: () => void;
}) {
  const hasOffer = !!entry.offer;
  const where = [entry.venue_name, entry.court_name].filter(Boolean).join(' · ') || 'Platz';

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityLabel={
        hasOffer
          ? `Platz reserviert bei ${where}, jetzt sichern`
          : `Warteschlange Position ${entry.position} von ${entry.queue_length} bei ${where}`
      }
      style={[
        styles.queueRow,
        {
          backgroundColor: hasOffer ? colors.primary + '18' : colors.surface,
          borderColor: hasOffer ? (colors.primary as string) : colors.cardBorder,
        },
      ]}
    >
      <View
        style={[
          styles.queueBadge,
          { backgroundColor: hasOffer ? (colors.primary as string) : colors.surfaceSecondary },
        ]}
      >
        {hasOffer ? (
          <Ionicons name="flash" size={18} color="#FFF" />
        ) : (
          <Text style={[styles.queuePos, { color: colors.textPrimary }]}>
            {entry.position ?? '–'}
          </Text>
        )}
      </View>

      <View style={styles.queueBody}>
        <Text style={[styles.queueVenue, { color: colors.textPrimary }]} numberOfLines={1}>
          {where}
        </Text>
        <Text style={[styles.queueMeta, { color: colors.textTertiary }]}>
          {formatDate(new Date(`${String(entry.slot_date).slice(0, 10)}T12:00:00`))} ·{' '}
          {formatTime(entry.slot_start)}–{formatTime(entry.slot_end)} Uhr
        </Text>
        <Text
          style={[styles.queueStatus, { color: hasOffer ? colors.primary : colors.textTertiary }]}
        >
          {hasOffer
            ? 'Für dich reserviert — jetzt sichern'
            : `Platz ${entry.position ?? '–'} von ${entry.queue_length}`}
        </Text>
      </View>

      <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  queueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
  },
  queueBadge: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  queuePos: { fontSize: fontSize.base, fontWeight: fontWeight.bold as any, fontVariant: ['tabular-nums'] },
  queueBody: { flex: 1, gap: 1 },
  queueVenue: { fontSize: fontSize.base, fontWeight: fontWeight.semibold as any },
  queueMeta: { fontSize: fontSize.xs },
  queueStatus: { fontSize: fontSize.xs, fontWeight: fontWeight.medium as any, marginTop: 1 },
  loader: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  listContent: { padding: spacing.lg, gap: spacing.md, paddingBottom: 120 },
  sectionHeader: {
    fontSize: fontSize.xxs,
    fontWeight: fontWeight.bold as any,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  card: {
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing.sm,
  },
  cardRow: { flexDirection: 'row', justifyContent: 'space-between' },
  cardLeft: { flex: 1 },
  cardRight: { alignItems: 'flex-end' },
  cardDate: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold as any, marginBottom: 2 },
  cardTime: { fontSize: fontSize.xl, fontWeight: '800' as any },
  cardPrice: { fontSize: fontSize.lg, fontWeight: '800' as any },
  cardStatus: {
    fontSize: fontSize.xxs,
    fontWeight: fontWeight.bold as any,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  venueRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  venueText: { fontSize: fontSize.sm, flex: 1 },
  cancelBtn: {
    marginTop: spacing.xs,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    minHeight: 40,
    justifyContent: 'center',
  },
  cancelText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold as any },
  empty: { alignItems: 'center', padding: spacing.xxl, gap: spacing.sm },
  emptyTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.semibold as any },
  emptyText: {
    fontSize: fontSize.sm,
    textAlign: 'center',
    paddingHorizontal: spacing.lg,
  },
  findBtn: {
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
  },
  findBtnText: { color: '#FFF', fontSize: fontSize.sm, fontWeight: fontWeight.bold as any },
  errorText: {
    position: 'absolute',
    bottom: spacing.lg,
    left: 0,
    right: 0,
    textAlign: 'center',
    fontSize: fontSize.sm,
  },
});
