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
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useTheme } from '../../../src/providers/ThemeProvider';
import { spacing, fontSize, fontWeight, radius } from '../../../src/theme/spacing';
import { getVenueAvailability, type AvailabilitySlot } from '../../../src/api/v2';
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
      setConfirmSlot(slot);
    },
    [isAuthenticated, router]
  );

  const confirmBook = useCallback(async () => {
    if (!confirmSlot) return;
    setBooking(true);
    try {
      await book(confirmSlot.id);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      showToast('success', 'Platz gebucht', 'Siehe „Meine Buchungen"');
      // Reflect the new booking locally so the slot can no longer be tapped.
      setSlots((prev) =>
        prev.map((s) => (s.id === confirmSlot.id ? { ...s, status: 'booked' } : s))
      );
      setConfirmSlot(null);
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
}: {
  slot: AvailabilitySlot;
  colors: Colors;
  onPress: () => void;
}) {
  const isAvailable = slot.status === 'available';
  const isBlocked = slot.status === 'blocked';
  const price = formatPrice(slot.price_cents);

  return (
    <TouchableOpacity
      disabled={!isAvailable}
      onPress={onPress}
      activeOpacity={0.85}
      style={[
        styles.slotCard,
        {
          backgroundColor: isAvailable ? colors.surface : colors.surfaceSecondary,
          borderColor: isAvailable ? colors.primary + '33' : colors.cardBorder,
          opacity: isAvailable ? 1 : 0.55,
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
      ) : (
        <Text style={[styles.statusText, { color: colors.textTertiary }]}>
          {isBlocked ? 'Blockiert' : 'Gebucht'}
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
