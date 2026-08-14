/**
 * Claim Screen — "Dieser Platz gehört dir, wenn du jetzt zugreifst."
 *
 * Reached from the offer push (`tourneo://slot/:id/claim`), from the
 * bookings screen, and from the queue sheet. It is the one screen in the
 * app with a hard deadline on it, so two things matter more than anything
 * else here:
 *
 *   1. The countdown is resynced from the server's `expires_at` on every
 *      focus. A timer that only counts down locally drifts while the app
 *      is backgrounded, and a user who returns to "3:12 left" on an offer
 *      that lapsed two minutes ago will tap Claim and be told no.
 *   2. "Weitergeben" is offered as a first-class action, not buried. It
 *      advances the queue immediately, feels generous to the next person,
 *      and costs us less than an expiry.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  Animated,
  Easing,
} from 'react-native';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useTheme } from '../../../src/providers/ThemeProvider';
import { spacing, fontSize, fontWeight, radius } from '../../../src/theme/spacing';
import { TButton, useToast } from '../../../src/components/common';
import { claimSlot, declineSlotOffer, getSlot, type SlotDetail } from '../../../src/api/v2';
import { useTopic } from '../../../src/realtime/RealtimeProvider';
import { useAuthStore } from '../../../src/store/authStore';

/** Below this the countdown turns urgent: red, and one haptic tick a second. */
const URGENT_SECONDS = 60;

function formatCountdown(totalSeconds: number): string {
  const safe = Math.max(0, totalSeconds);
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatTime(t?: string | null): string {
  return t ? String(t).slice(0, 5) : '';
}

function formatPrice(cents: number | null | undefined): string | null {
  if (cents === null || cents === undefined) return null;
  return cents % 100 === 0 ? `${cents / 100} €` : `${(cents / 100).toFixed(2)} €`;
}

function formatDate(iso?: string | null): string {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return '';
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('de-DE', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
}

export default function ClaimSlotScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const slotId = Number(id);
  const router = useRouter();
  const { colors } = useTheme();
  const toast = useToast();
  const userId = useAuthStore((s) => s.user?.id);

  const [slot, setSlot] = useState<SlotDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'claim' | 'decline' | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [expired, setExpired] = useState(false);

  const expiresAtRef = useRef<number | null>(null);
  const lastHapticSecond = useRef<number | null>(null);
  const pulse = useRef(new Animated.Value(1)).current;

  /** Recomputes the countdown from the server's absolute deadline. */
  const resync = useCallback((expiresAt: string | null | undefined) => {
    if (!expiresAt) {
      expiresAtRef.current = null;
      setSecondsLeft(null);
      return;
    }
    const deadline = new Date(expiresAt).getTime();
    expiresAtRef.current = deadline;
    const left = Math.floor((deadline - Date.now()) / 1000);
    setSecondsLeft(Math.max(0, left));
    if (left <= 0) setExpired(true);
  }, []);

  const load = useCallback(async () => {
    if (!Number.isInteger(slotId) || slotId <= 0) {
      setLoading(false);
      return;
    }
    try {
      const detail = await getSlot(slotId);
      setSlot(detail);
      // `hold` is only populated while the slot is held; the server never
      // says who holds it, so an offer we can act on is one where our own
      // entry says 'offered'.
      resync(detail.hold?.expires_at ?? null);
      if (detail.status !== 'held') setExpired(true);
    } catch {
      toast.show('error', 'Angebot konnte nicht geladen werden');
    } finally {
      setLoading(false);
    }
  }, [slotId, resync, toast]);

  // Resync on every focus — the app may have been backgrounded for
  // minutes, and a locally-drifted timer is worse than no timer.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  // The slot topic tells us if the hold ended while we were looking at it
  // (we declined on another device, or it expired server-side).
  useTopic(Number.isInteger(slotId) && slotId > 0 ? `slot:${slotId}` : null, (event) => {
    if (event.event === 'slot_freed' || event.event === 'slot_booked') {
      setExpired(true);
      setSecondsLeft(0);
    }
  });

  // Our own topic carries the authoritative offer lifecycle.
  useTopic(userId ? `user:${userId}` : null, (event) => {
    if (event.payload?.slot_id !== slotId) return;
    if (event.event === 'offer_expired') {
      setExpired(true);
      setSecondsLeft(0);
    }
  });

  /* ── the ticking clock ─────────────────────────────────────── */
  useEffect(() => {
    if (secondsLeft === null || expired) return;
    const timer = setInterval(() => {
      const deadline = expiresAtRef.current;
      if (!deadline) return;
      const left = Math.max(0, Math.floor((deadline - Date.now()) / 1000));
      setSecondsLeft(left);
      if (left <= 0) setExpired(true);
    }, 1000);
    return () => clearInterval(timer);
  }, [secondsLeft === null, expired]);

  /* ── urgency: one haptic tick per second under a minute ────── */
  useEffect(() => {
    if (secondsLeft === null || expired) return;
    if (secondsLeft > URGENT_SECONDS || secondsLeft <= 0) return;
    if (lastHapticSecond.current === secondsLeft) return;
    lastHapticSecond.current = secondsLeft;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
  }, [secondsLeft, expired]);

  /* ── ambient pulse while the offer is live ─────────────────── */
  useEffect(() => {
    if (expired || secondsLeft === null) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1.04,
          duration: 900,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 1,
          duration: 900,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [expired, secondsLeft === null, pulse]);

  const handleClaim = async () => {
    if (busy) return;
    setBusy('claim');
    try {
      await claimSlot(slotId);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      toast.show('success', 'Platz gesichert! 🎾');
      router.replace('/bookings');
    } catch (err: any) {
      const message =
        err?.response?.status === 409
          ? 'Das Angebot ist leider abgelaufen.'
          : 'Der Platz konnte nicht gesichert werden.';
      toast.show('error', message);
      if (err?.response?.status === 409) setExpired(true);
    } finally {
      setBusy(null);
    }
  };

  const handleDecline = async () => {
    if (busy) return;
    setBusy('decline');
    try {
      await declineSlotOffer(slotId);
      toast.show('success', 'Weitergegeben — danke!');
      router.back();
    } catch {
      toast.show('error', 'Konnte nicht weitergegeben werden');
    } finally {
      setBusy(null);
    }
  };

  const urgent = secondsLeft !== null && secondsLeft <= URGENT_SECONDS;
  const ringColor = expired
    ? (colors.textTertiary as string)
    : urgent
      ? (colors.error as string)
      : (colors.primary as string);

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.bg }]}>
        <Stack.Screen options={{ headerShown: false }} />
        <ActivityIndicator color={colors.primary as string} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <Stack.Screen options={{ headerShown: false }} />

      <TouchableOpacity
        onPress={() => router.back()}
        style={styles.close}
        accessibilityRole="button"
        accessibilityLabel="Schließen"
      >
        <Ionicons name="close" size={26} color={colors.textSecondary as string} />
      </TouchableOpacity>

      <View style={styles.body}>
        <Text style={[styles.kicker, { color: urgent ? colors.error : colors.primary }]}>
          {expired ? 'Angebot abgelaufen' : 'Ein Platz ist frei geworden'}
        </Text>

        <Animated.View
          style={[
            styles.ring,
            { borderColor: ringColor, transform: [{ scale: expired ? 1 : pulse }] },
          ]}
        >
          <Text
            style={[styles.countdown, { color: ringColor }]}
            accessibilityLabel={
              expired
                ? 'Angebot abgelaufen'
                : `Noch ${formatCountdown(secondsLeft ?? 0)} Minuten Zeit`
            }
          >
            {expired ? '0:00' : formatCountdown(secondsLeft ?? 0)}
          </Text>
          <Text style={[styles.ringLabel, { color: colors.textTertiary }]}>
            {expired ? 'vorbei' : 'reserviert für dich'}
          </Text>
        </Animated.View>

        <View style={[styles.card, { backgroundColor: colors.bgSecondary, borderColor: colors.border }]}>
          <Text style={[styles.venue, { color: colors.textPrimary }]}>
            {slot?.venue_name ?? 'Platz'}
          </Text>
          {!!slot?.court_name && (
            <Text style={[styles.court, { color: colors.textSecondary }]}>{slot.court_name}</Text>
          )}
          <Text style={[styles.when, { color: colors.textSecondary }]}>
            {formatDate(slot?.slot_date)}
          </Text>
          <Text style={[styles.time, { color: colors.textPrimary }]}>
            {formatTime(slot?.slot_start)} – {formatTime(slot?.slot_end)} Uhr
          </Text>
          {!!formatPrice(slot?.price_cents) && (
            <Text style={[styles.price, { color: colors.primary }]}>
              {formatPrice(slot?.price_cents)}
            </Text>
          )}
        </View>
      </View>

      <View style={styles.actions}>
        {expired ? (
          <TButton title="Zurück" onPress={() => router.back()} size="lg" variant="outline" />
        ) : (
          <>
            <TButton
              title="Platz sichern"
              onPress={handleClaim}
              loading={busy === 'claim'}
              disabled={busy !== null}
              size="lg"
            />
            <TouchableOpacity
              onPress={handleDecline}
              disabled={busy !== null}
              style={styles.pass}
              accessibilityRole="button"
              accessibilityLabel="Angebot an den Nächsten weitergeben"
            >
              <Text style={[styles.passText, { color: colors.textTertiary }]}>
                {busy === 'decline' ? 'Wird weitergegeben…' : 'Weitergeben'}
              </Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  close: { position: 'absolute', top: 56, right: spacing.lg, zIndex: 2, padding: spacing.xs },
  body: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xl },
  kicker: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginBottom: spacing.xl,
    textAlign: 'center',
  },
  ring: {
    width: 200,
    height: 200,
    borderRadius: 100,
    borderWidth: 4,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xl,
  },
  countdown: { fontSize: 52, fontWeight: fontWeight.bold, fontVariant: ['tabular-nums'] },
  ringLabel: { fontSize: fontSize.xs, marginTop: spacing.xs },
  card: {
    width: '100%',
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: spacing.lg,
    alignItems: 'center',
    gap: 2,
  },
  venue: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, textAlign: 'center' },
  court: { fontSize: fontSize.sm },
  when: { fontSize: fontSize.sm, marginTop: spacing.xs },
  time: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, marginTop: 2 },
  price: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, marginTop: spacing.xs },
  actions: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xxl, gap: spacing.sm },
  pass: { alignItems: 'center', paddingVertical: spacing.md },
  passText: { fontSize: fontSize.sm, fontWeight: fontWeight.medium },
});
