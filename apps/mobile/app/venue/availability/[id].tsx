/**
 * Court Availability Screen
 *
 *   - Horizontal day picker (next 14 days). Days with no slots are
 *     visually dimmed and the dot is hidden.
 *   - Slot grid for the selected day. Tapping an available slot opens
 *     a confirmation sheet; tapping "Buchen" calls the in-app booking
 *     API. If the slot only carries an external booking URL (legacy /
 *     partner integration) we still link out.
 *   - Optimistic UI is intentionally avoided here — the server holds the
 *     slot lock, so we wait for its decision and surface 409s as a clear
 *     "Slot ist gerade weg" toast.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Linking,
  RefreshControl,
} from 'react-native';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as WebBrowser from 'expo-web-browser';
import { useTheme } from '../../../src/providers/ThemeProvider';
import { spacing, fontSize, fontWeight, radius } from '../../../src/theme/spacing';
import {
  getVenueAvailability,
  joinSlotQueue,
  leaveSlotQueue,
  type AvailabilitySlot,
  type QueueStanding,
} from '../../../src/api/v2';
import { useTopic } from '../../../src/realtime/RealtimeProvider';
import type { Colors } from '../../../src/theme/colors';
import { useBookingStore } from '../../../src/store/bookingStore';
import { useAuthStore } from '../../../src/store/authStore';
import { TModal } from '../../../src/components/common';
import { useToast } from '../../../src/components/common';

function buildNextDays(count: number): Date[] {
  const result: Date[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 0; i < count; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    result.push(d);
  }
  return result;
}

function dateKey(d: Date): string {
  // Use local-time key so the picker matches the device's "today",
  // not UTC midnight. toISOString().slice(0,10) would silently shift.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatTime(t: string): string {
  // server format is HH:MM:SS
  return t.slice(0, 5);
}

function formatPrice(cents: number | null): string | null {
  if (cents === null || cents === undefined) return null;
  if (cents % 100 === 0) return `${cents / 100} €`;
  return `${(cents / 100).toFixed(2)} €`;
}

export default function CourtAvailabilityScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const venueId = Number(id);
  const { colors } = useTheme();
  const router = useRouter();
  const { isAuthenticated } = useAuthStore();
  const { book } = useBookingStore();
  const showToast = useToast((s) => s.show);

  const days = useMemo(() => buildNextDays(14), []);
  const [selectedDate, setSelectedDate] = useState<Date>(days[0]);
  const [slots, setSlots] = useState<AvailabilitySlot[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [confirmSlot, setConfirmSlot] = useState<AvailabilitySlot | null>(null);
  const [booking, setBooking] = useState(false);

  /** Slot the user tapped to queue for, and their standing once joined. */
  const [queueSlot, setQueueSlot] = useState<AvailabilitySlot | null>(null);
  const [standing, setStanding] = useState<QueueStanding | null>(null);
  const [queueBusy, setQueueBusy] = useState(false);
  /** Slots this user is queued for, so the grid can show it at a glance. */
  const [myQueuedSlotIds, setMyQueuedSlotIds] = useState<Set<number>>(new Set());

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await getVenueAvailability(venueId, {
        from: dateKey(days[0]),
        to: dateKey(days[days.length - 1]),
      });
      setSlots(data);
    } catch (err: any) {
      setError(
        err?.response?.data?.error?.message || 'Verfügbarkeit konnte nicht geladen werden.'
      );
    }
  }, [venueId, days]);

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  /**
   * Live venue state. The socket is an optimisation, never the source of
   * truth: state transitions are applied in place for instant feedback,
   * and a `resync` (or a screen focus) falls back to the REST fetch.
   */
  const { connected, resyncAt } = useTopic(
    Number.isInteger(venueId) && venueId > 0 ? `venue:${venueId}` : null,
    (event) => {
      const slotId = Number(event.payload?.slot_id);
      if (!Number.isInteger(slotId)) return;

      if (event.event === 'slot_freed') {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        setSlots((prev) =>
          prev.map((s) => (s.id === slotId ? { ...s, status: 'available' } : s))
        );
      } else if (event.event === 'slot_held') {
        setSlots((prev) => prev.map((s) => (s.id === slotId ? { ...s, status: 'held' } : s)));
      } else if (event.event === 'slot_booked') {
        setSlots((prev) => prev.map((s) => (s.id === slotId ? { ...s, status: 'booked' } : s)));
      } else if (event.event === 'queue_changed') {
        const queueLength = Number(event.payload?.queue_length ?? 0);
        setSlots((prev) =>
          prev.map((s) => (s.id === slotId ? { ...s, queue_length: queueLength } : s))
        );
      }
    }
  );

  useEffect(() => {
    if (resyncAt) load();
  }, [resyncAt, load]);

  // Belt and braces: the socket dies while backgrounded on iOS, so a
  // refetch on focus guarantees the grid is never stale on return.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const daysWithSlots = useMemo(() => {
    const map = new Map<string, number>();
    for (const slot of slots) {
      if (slot.status !== 'available') continue;
      const k = slot.slot_date.slice(0, 10);
      map.set(k, (map.get(k) ?? 0) + 1);
    }
    return map;
  }, [slots]);

  const slotsForSelected = useMemo(() => {
    const key = dateKey(selectedDate);
    return slots
      .filter((s) => s.slot_date.slice(0, 10) === key)
      .sort((a, b) => a.slot_start.localeCompare(b.slot_start));
  }, [slots, selectedDate]);

  const onSlotPress = useCallback(
    (slot: AvailabilitySlot) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      if (!isAuthenticated) {
        router.push('/(auth)/login' as any);
        return;
      }
      // An available slot is booked directly; anything taken opens the
      // queue instead of being a dead end.
      if (slot.status === 'available') setConfirmSlot(slot);
      else if (slot.status === 'booked' || slot.status === 'held') {
        setStanding(null);
        setQueueSlot(slot);
      }
    },
    [isAuthenticated, router]
  );

  const joinQueue = useCallback(async () => {
    if (!queueSlot) return;
    setQueueBusy(true);
    try {
      const result = await joinSlotQueue(queueSlot.id);
      setStanding(result);
      setMyQueuedSlotIds((prev) => new Set(prev).add(queueSlot.id));
      setSlots((prev) =>
        prev.map((s) => (s.id === queueSlot.id ? { ...s, queue_length: result.queue_length } : s))
      );
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } catch (err: any) {
      if (err?.response?.status === 409) {
        // The slot freed up between render and tap — just book it.
        showToast('info', 'Der Platz ist gerade frei', 'Du kannst ihn direkt buchen.');
        await load();
        setQueueSlot(null);
      } else {
        showToast(
          'error',
          'Warteschlange nicht möglich',
          err?.response?.data?.error?.message || 'Bitte später erneut versuchen.'
        );
      }
    } finally {
      setQueueBusy(false);
    }
  }, [queueSlot, showToast, load]);

  const leaveQueue = useCallback(async () => {
    if (!queueSlot) return;
    setQueueBusy(true);
    try {
      await leaveSlotQueue(queueSlot.id);
      setMyQueuedSlotIds((prev) => {
        const next = new Set(prev);
        next.delete(queueSlot.id);
        return next;
      });
      setStanding(null);
      setQueueSlot(null);
      showToast('success', 'Warteschlange verlassen');
    } catch {
      showToast('error', 'Konnte die Warteschlange nicht verlassen');
    } finally {
      setQueueBusy(false);
    }
  }, [queueSlot, showToast]);

  const confirmBook = useCallback(async () => {
    if (!confirmSlot) return;
    setBooking(true);
    try {
      const result = await book(confirmSlot.id);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});

      // Reflect the new booking locally so the slot can no longer be tapped.
      setSlots((prev) =>
        prev.map((s) => (s.id === confirmSlot.id ? { ...s, status: 'booked' } : s))
      );
      setConfirmSlot(null);

      if (result.status === 'pending_payment' && result.client_secret) {
        // Stripe-connected venue: confirm the PaymentIntent in the hosted
        // sheet. The webhook flips the booking to confirmed; unpaid
        // bookings auto-expire after 15 minutes and free the slot.
        showToast('info', 'Fast geschafft', 'Bitte Zahlung abschließen (15 Min Zeit).');
        const paymentIntentId = result.client_secret.split('_secret')[0];
        const url =
          `https://hooks.stripe.com/redirect/authenticate/src_${paymentIntentId}` +
          `?client_secret=${encodeURIComponent(result.client_secret)}` +
          `&return_url=${encodeURIComponent('tourneo://booking/callback')}`;
        await WebBrowser.openAuthSessionAsync(url, 'tourneo://booking/callback');
      } else {
        showToast('success', 'Platz gebucht', 'Siehe „Meine Buchungen"');
      }
    } catch (err: any) {
      const code = err?.response?.status;
      const msg =
        code === 409
          ? 'Dieser Slot wurde gerade gebucht. Bitte einen anderen wählen.'
          : err?.response?.data?.error?.message || 'Buchung fehlgeschlagen.';
      showToast('error', 'Buchung fehlgeschlagen', msg);
      if (code === 409) {
        // Refresh to drop the now-taken slot from the grid.
        await load();
        setConfirmSlot(null);
      }
    } finally {
      setBooking(false);
    }
  }, [confirmSlot, book, showToast, load]);

  if (loading) {
    return (
      <View style={[styles.loader, { backgroundColor: colors.bg }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <Stack.Screen options={{ title: 'Platz-Verfügbarkeit', headerShown: true }} />

      {/* The user should always know whether they are seeing live truth
          or a snapshot — a silent stale grid is worse than an honest one. */}
      <View style={styles.liveRow}>
        <View
          style={[
            styles.liveDot,
            { backgroundColor: connected ? (colors.success as string) : colors.textTertiary },
          ]}
        />
        <Text style={[styles.liveText, { color: colors.textTertiary }]}>
          {connected ? 'Live — freie Plätze erscheinen sofort' : 'Verbindung…'}
        </Text>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.daysRow}
      >
        {days.map((d) => {
          const isSelected = dateKey(d) === dateKey(selectedDate);
          const hasSlots = (daysWithSlots.get(dateKey(d)) ?? 0) > 0;
          return (
            <TouchableOpacity
              key={dateKey(d)}
              onPress={() => {
                Haptics.selectionAsync().catch(() => {});
                setSelectedDate(d);
              }}
              style={[
                styles.dayChip,
                {
                  backgroundColor: isSelected ? colors.primary : colors.surface,
                  borderColor: isSelected ? colors.primary : colors.cardBorder,
                  opacity: hasSlots || isSelected ? 1 : 0.55,
                },
              ]}
            >
              <Text
                style={[
                  styles.dayLabel,
                  { color: isSelected ? '#FFF' : colors.textTertiary },
                ]}
              >
                {d.toLocaleDateString('de-DE', { weekday: 'short' })}
              </Text>
              <Text
                style={[
                  styles.dayNum,
                  { color: isSelected ? '#FFF' : colors.textPrimary },
                ]}
              >
                {d.getDate()}
              </Text>
              {hasSlots && !isSelected && (
                <View style={[styles.dayDot, { backgroundColor: colors.primary }]} />
              )}
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      <ScrollView
        contentContainerStyle={styles.slotsContainer}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        }
      >
        {error && <Text style={[styles.errorText, { color: colors.error }]}>{error}</Text>}

        {slotsForSelected.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="calendar-outline" size={48} color={colors.textTertiary} />
            <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>
              Keine Verfügbarkeit
            </Text>
            <Text style={[styles.emptyText, { color: colors.textTertiary }]}>
              Für diesen Tag sind keine Slots hinterlegt. Wähle einen anderen Tag.
            </Text>
          </View>
        ) : (
          <View style={styles.slotGrid}>
            {slotsForSelected.map((slot) => (
              <SlotCard
                key={slot.id}
                slot={slot}
                colors={colors}
                queued={myQueuedSlotIds.has(slot.id)}
                onPress={() => onSlotPress(slot)}
              />
            ))}
          </View>
        )}

        <TouchableOpacity
          style={[styles.myBookingsLink, { borderColor: colors.cardBorder }]}
          onPress={() => router.push('/(tabs)/profil')}
        >
          <Ionicons name="ticket-outline" size={18} color={colors.primary} />
          <Text style={[styles.myBookingsText, { color: colors.textPrimary }]}>
            Meine Buchungen ansehen
          </Text>
          <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
        </TouchableOpacity>
      </ScrollView>

      <TModal
        visible={!!queueSlot}
        onClose={() => !queueBusy && setQueueSlot(null)}
        title={standing ? 'Du stehst an' : 'In die Warteschlange'}
      >
        {queueSlot && (
          <View style={styles.modalContent}>
            <Text style={[styles.modalLine, { color: colors.textPrimary }]}>
              {formatTime(queueSlot.slot_start)} – {formatTime(queueSlot.slot_end)} Uhr
            </Text>

            {standing ? (
              <>
                <Text style={[styles.queuePosition, { color: colors.primary }]}>
                  #{standing.position}
                </Text>
                <Text style={[styles.modalHint, { color: colors.textTertiary }]}>
                  von {standing.queue_length} in der Warteschlange
                </Text>
                {standing.ahead_of_you.club + standing.ahead_of_you.plus > 0 && (
                  <Text style={[styles.modalHint, { color: colors.textTertiary }]}>
                    {standing.ahead_of_you.club > 0 &&
                      `${standing.ahead_of_you.club} Club-${standing.ahead_of_you.club === 1 ? 'Mitglied' : 'Mitglieder'}`}
                    {standing.ahead_of_you.club > 0 && standing.ahead_of_you.plus > 0 && ' und '}
                    {standing.ahead_of_you.plus > 0 &&
                      `${standing.ahead_of_you.plus} Plus-${standing.ahead_of_you.plus === 1 ? 'Mitglied' : 'Mitglieder'}`}
                    {' vor dir'}
                  </Text>
                )}
                {/* Only shown when upgrading would genuinely move them up. */}
                {standing.position_if_plus !== null &&
                  standing.position_if_plus < standing.position && (
                    <TouchableOpacity
                      onPress={() => {
                        setQueueSlot(null);
                        router.push('/membership');
                      }}
                      style={[styles.upgradeHint, { borderColor: colors.primary + '55' }]}
                    >
                      <Ionicons name="flash-outline" size={16} color={colors.primary} />
                      <Text style={[styles.upgradeText, { color: colors.primary }]}>
                        Mit Plus wärst du #{standing.position_if_plus}
                      </Text>
                    </TouchableOpacity>
                  )}
                <Text style={[styles.modalHint, { color: colors.textTertiary }]}>
                  Wird der Platz frei, halten wir ihn 10 Minuten für dich und schicken dir eine
                  Benachrichtigung.
                </Text>
                <TouchableOpacity
                  onPress={leaveQueue}
                  disabled={queueBusy}
                  style={styles.leaveQueueBtn}
                >
                  <Text style={[styles.leaveQueueText, { color: colors.error }]}>
                    {queueBusy ? 'Einen Moment…' : 'Warteschlange verlassen'}
                  </Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <Text style={[styles.modalHint, { color: colors.textTertiary }]}>
                  Dieser Platz ist belegt.
                  {(queueSlot.queue_length ?? 0) > 0
                    ? ` ${queueSlot.queue_length} ${queueSlot.queue_length === 1 ? 'Person wartet' : 'Personen warten'} bereits.`
                    : ' Du wärst der Erste in der Warteschlange.'}
                </Text>
                <Text style={[styles.modalHint, { color: colors.textTertiary }]}>
                  Wird er frei, gehört er 10 Minuten lang dir.
                </Text>
                <View style={styles.modalActions}>
                  <TouchableOpacity
                    style={[styles.modalBtn, { backgroundColor: colors.surfaceSecondary }]}
                    disabled={queueBusy}
                    onPress={() => setQueueSlot(null)}
                  >
                    <Text style={[styles.modalBtnText, { color: colors.textPrimary }]}>
                      Abbrechen
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.modalBtn,
                      { backgroundColor: colors.primary, opacity: queueBusy ? 0.7 : 1 },
                    ]}
                    disabled={queueBusy}
                    onPress={joinQueue}
                  >
                    {queueBusy ? (
                      <ActivityIndicator color="#FFF" />
                    ) : (
                      <Text style={[styles.modalBtnText, { color: '#FFF' }]}>Anstellen</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
        )}
      </TModal>

      <TModal
        visible={!!confirmSlot}
        onClose={() => !booking && setConfirmSlot(null)}
        title="Platz buchen"
      >
        {confirmSlot && (
          <View style={styles.modalContent}>
            <Text style={[styles.modalLine, { color: colors.textPrimary }]}>
              {selectedDate.toLocaleDateString('de-DE', {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
              })}
            </Text>
            <Text style={[styles.modalLineBig, { color: colors.textPrimary }]}>
              {formatTime(confirmSlot.slot_start)} – {formatTime(confirmSlot.slot_end)}
            </Text>
            {formatPrice(confirmSlot.price_cents) && (
              <Text style={[styles.modalPrice, { color: colors.primary }]}>
                {formatPrice(confirmSlot.price_cents)}
              </Text>
            )}
            <Text style={[styles.modalHint, { color: colors.textTertiary }]}>
              Zahlung erfolgt vor Ort. Du kannst die Buchung bis 2 Stunden vor Start kostenfrei
              stornieren.
            </Text>

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalBtn, { backgroundColor: colors.surfaceSecondary }]}
                disabled={booking}
                onPress={() => setConfirmSlot(null)}
              >
                <Text style={[styles.modalBtnText, { color: colors.textPrimary }]}>Abbrechen</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.modalBtn,
                  { backgroundColor: colors.primary, opacity: booking ? 0.7 : 1 },
                ]}
                disabled={booking}
                onPress={confirmBook}
              >
                {booking ? (
                  <ActivityIndicator color="#FFF" />
                ) : (
                  <Text style={[styles.modalBtnText, { color: '#FFF' }]}>Jetzt buchen</Text>
                )}
              </TouchableOpacity>
            </View>

            {confirmSlot.booking_url && (
              <TouchableOpacity
                onPress={() => {
                  Linking.openURL(confirmSlot.booking_url!);
                  setConfirmSlot(null);
                }}
              >
                <Text style={[styles.externalLink, { color: colors.textTertiary }]}>
                  Stattdessen extern buchen ↗
                </Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </TModal>
    </View>
  );
}

function SlotCard({
  slot,
  colors,
  onPress,
  queued,
}: {
  slot: AvailabilitySlot;
  colors: Colors;
  onPress: () => void;
  queued: boolean;
}) {
  const isAvailable = slot.status === 'available';
  const isBlocked = slot.status === 'blocked';
  const isHeld = slot.status === 'held';
  const price = formatPrice(slot.price_cents);
  const queueLength = slot.queue_length ?? 0;

  // Only a blocked slot is a genuine dead end. Booked and held slots are
  // now the entry point to the queue, so they stay tappable and legible
  // instead of being dimmed out of the interface.
  const interactive = isAvailable || isBlocked === false;

  return (
    <TouchableOpacity
      disabled={isBlocked}
      onPress={onPress}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityLabel={
        isAvailable
          ? `${formatTime(slot.slot_start)} Uhr buchen`
          : isBlocked
            ? `${formatTime(slot.slot_start)} Uhr blockiert`
            : `${formatTime(slot.slot_start)} Uhr belegt, ${queueLength} in der Warteschlange`
      }
      style={[
        styles.slotCard,
        {
          backgroundColor: isAvailable ? colors.surface : colors.surfaceSecondary,
          borderColor: isAvailable
            ? colors.primary + '33'
            : queued
              ? (colors.primary as string)
              : colors.cardBorder,
          opacity: interactive ? 1 : 0.55,
        },
      ]}
    >
      <Text style={[styles.slotTime, { color: colors.textPrimary }]}>
        {formatTime(slot.slot_start)} – {formatTime(slot.slot_end)}
      </Text>
      {price && <Text style={[styles.slotPrice, { color: colors.primary }]}>{price}</Text>}

      {isAvailable ? (
        <View style={[styles.bookBtn, { backgroundColor: colors.primary }]}>
          <Text style={styles.bookText}>Buchen</Text>
        </View>
      ) : isBlocked ? (
        <Text style={[styles.statusText, { color: colors.textTertiary }]}>Blockiert</Text>
      ) : queued ? (
        <View style={[styles.bookBtn, { backgroundColor: colors.primary + '22' }]}>
          <Text style={[styles.bookText, { color: colors.primary }]}>In Warteschlange</Text>
        </View>
      ) : (
        <Text style={[styles.statusText, { color: colors.textTertiary }]}>
          {isHeld ? 'Wird vergeben' : queueLength > 0 ? `Belegt · ${queueLength} warten` : 'Belegt'}
        </Text>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  loader: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  daysRow: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.sm,
  },
  dayChip: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    minWidth: 56,
    gap: 2,
  },
  dayLabel: {
    fontSize: fontSize.xxs,
    fontWeight: fontWeight.semibold as any,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  dayNum: { fontSize: fontSize.xl, fontWeight: '800' as any },
  dayDot: { width: 4, height: 4, borderRadius: 2, marginTop: 2 },
  slotsContainer: { padding: spacing.lg, paddingBottom: 100 },
  slotGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  slotCard: {
    width: '48%',
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    alignItems: 'center',
    gap: spacing.xs,
  },
  slotTime: { fontSize: fontSize.base, fontWeight: fontWeight.semibold as any },
  slotPrice: { fontSize: fontSize.lg, fontWeight: '800' as any },
  bookBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.md,
    marginTop: spacing.xs,
  },
  bookText: { color: '#FFF', fontSize: fontSize.xs, fontWeight: fontWeight.bold as any },
  statusText: { fontSize: fontSize.xxs, marginTop: spacing.xs },
  empty: { alignItems: 'center', padding: spacing.xxl, gap: spacing.sm },
  emptyTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.semibold as any },
  emptyText: { fontSize: fontSize.sm, textAlign: 'center', paddingHorizontal: spacing.lg },
  errorText: { fontSize: fontSize.sm, textAlign: 'center', marginBottom: spacing.md },
  myBookingsLink: {
    marginTop: spacing.xl,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  myBookingsText: { flex: 1, fontSize: fontSize.sm, fontWeight: fontWeight.semibold as any },
  liveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  liveDot: { width: 7, height: 7, borderRadius: 4 },
  liveText: { fontSize: fontSize.xs },
  queuePosition: {
    fontSize: 44,
    fontWeight: fontWeight.bold as any,
    fontVariant: ['tabular-nums'],
    marginTop: spacing.sm,
  },
  upgradeHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    marginTop: spacing.sm,
  },
  upgradeText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold as any },
  leaveQueueBtn: { paddingVertical: spacing.md, marginTop: spacing.sm },
  leaveQueueText: { fontSize: fontSize.sm, fontWeight: fontWeight.medium as any },
  modalContent: { gap: spacing.sm, paddingTop: spacing.sm },
  modalLine: { fontSize: fontSize.sm },
  modalLineBig: { fontSize: fontSize.xl, fontWeight: '800' as any },
  modalPrice: { fontSize: fontSize.lg, fontWeight: '800' as any, marginTop: spacing.xs },
  modalHint: { fontSize: fontSize.xs, marginTop: spacing.sm, lineHeight: 18 },
  modalActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  modalBtn: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  modalBtnText: { fontSize: fontSize.base, fontWeight: fontWeight.semibold as any },
  externalLink: {
    fontSize: fontSize.xs,
    textAlign: 'center',
    marginTop: spacing.md,
    textDecorationLine: 'underline',
  },
});
