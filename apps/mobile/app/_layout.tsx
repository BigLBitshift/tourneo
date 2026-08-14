/**
 * Root Layout – Tourneo
 * - Consent gate: redirects unauthenticated-but-logged-in users to consent screen
 * - Registers all stack screens (notifications, leaderboard, checkout)
 * - Initialises push-notification token on app start
 */
import React, { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { useAuthStore } from '../src/store/authStore';
import { useConsentStore } from '../src/store/consentStore';
import { useNotificationStore } from '../src/store/notificationStore';
import { useFavoritesStore } from '../src/store/favoritesStore';
import { useTheme } from '../src/providers/ThemeProvider';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { RealtimeProvider } from '../src/realtime/RealtimeProvider';
import { OfflineBanner } from '../src/components/OfflineBanner';
import { initCrashReporting, setCrashUser } from '../src/utils/crashReport';

/* ── Push-notification handler (foreground) ─────────────────────── */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

/* ── Helper: register for push notifications ─────────────────── */
async function registerForPushNotifications(): Promise<string | null> {
  if (Platform.OS === 'web') return null;

  const { status: existing } = await Notifications.getPermissionsAsync();
  let finalStatus = existing;

  if (existing !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== 'granted') return null;

  try {
    const tokenData = await Notifications.getExpoPushTokenAsync({
      projectId: process.env.EXPO_PUBLIC_EXPO_PROJECT_ID,
    });
    return tokenData.data;
  } catch {
    return null;
  }
}

/**
 * Resolves a notification's payload to an in-app route.
 *
 * Explicit `deeplink` wins; the rest is a fallback for older payloads that
 * only carried ids. Returns null when there is nowhere sensible to go, so
 * a tap never lands the user on a broken screen.
 */
function routeForNotification(data: Record<string, any> | undefined): string | null {
  if (!data) return null;

  const deeplink = typeof data.deeplink === 'string' ? data.deeplink : null;
  if (deeplink?.startsWith('tourneo://')) {
    const path = deeplink.slice('tourneo://'.length);
    return path.startsWith('/') ? path : `/${path}`;
  }

  if (data.offer_id && data.slot_id) return `/slot/${data.slot_id}/claim`;
  if (data.booking_id) return '/bookings';
  if (data.event_id) return `/event/${data.event_id}`;
  return null;
}

/* ── Root Layout ─────────────────────────────────────────────── */
export default function RootLayout() {
  const { colors } = useTheme();
  const router = useRouter();
  const segments = useSegments();

  const initialize = useAuthStore((s) => s.initialize);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const user = useAuthStore((s) => s.user);

  const initializeConsent = useConsentStore((s) => s.initialize);
  const hasConsented = useConsentStore((s) => s.hasConsented);

  const registerPushToken = useNotificationStore((s) => s.registerPushToken);
  const fetchNotifications = useNotificationStore((s) => s.fetchNotifications);

  const initialised = useRef(false);

  /* ── App boot ─────────────────────────────────────────────── */
  useEffect(() => {
    initCrashReporting();
    const boot = async () => {
      try {
        await initialize();
        await initializeConsent();
        useFavoritesStore.getState().hydrate();
      } catch (err) {
        console.error('[boot] Initialization failed:', err);
      } finally {
        initialised.current = true;
      }
    };
    boot();
  }, []);

  /* ── Identify user for crash reporting ────────────────────── */
  useEffect(() => {
    if (user?.id) {
      setCrashUser({ id: user.id, email: user.email });
    } else {
      setCrashUser(null);
    }
  }, [user?.id, user?.email]);

  /* ── Push token registration (after auth) ─────────────────── */
  useEffect(() => {
    if (!isAuthenticated || !user) return;

    const setup = async () => {
      const token = await registerForPushNotifications();
      if (token) {
        await registerPushToken(token);
      }
      fetchNotifications();
    };
    setup();
  }, [isAuthenticated, user]);

  /* ── Notification taps ────────────────────────────────────── */
  useEffect(() => {
    const go = (data: Record<string, any> | undefined) => {
      const route = routeForNotification(data);
      if (route) router.push(route as never);
    };

    // Cold start: the offer push is specifically the one that arrives
    // while the app is dead, so the launch notification must be handled
    // separately — the listener below never fires for it.
    Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (response) go(response.notification.request.content.data as Record<string, any>);
      })
      .catch(() => undefined);

    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      go(response.notification.request.content.data as Record<string, any>);
    });

    return () => subscription.remove();
  }, [router]);

  /* ── Consent gate: redirect to consent if logged in but not consented ── */
  useEffect(() => {
    if (!initialised.current) return;
    if (!isAuthenticated) return;

    const inConsentScreen = segments.join('/').includes('consent');
    if (!hasConsented && !inConsentScreen) {
      router.replace('/(auth)/consent');
    }
  }, [isAuthenticated, hasConsented, segments]);

  return (
    <ErrorBoundary>
      <RealtimeProvider>
      <OfflineBanner />
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.bg },
        animation: 'slide_from_right',
        navigationBarColor: colors.bg,
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="(auth)" options={{ headerShown: false, presentation: 'modal' }} />
      <Stack.Screen name="event/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="event/register/[id]" options={{ headerShown: false, presentation: 'modal' }} />
      <Stack.Screen name="event/bracket/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="event/checkout/[id]" options={{ headerShown: false, presentation: 'modal' }} />
      <Stack.Screen name="event/referee/[matchId]" options={{ headerShown: false }} />
      <Stack.Screen name="event/live/[matchId]" options={{ headerShown: false }} />
      <Stack.Screen name="event/partners/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="event/chat/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="event/recap/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="event/waitlist/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="courts/index" options={{ headerShown: false }} />
      <Stack.Screen name="venue/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="venue/availability/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="slot/[id]/claim" options={{ headerShown: false, presentation: 'modal' }} />
      <Stack.Screen name="onboarding/playtomic" options={{ headerShown: false }} />
      <Stack.Screen name="onboarding/playtomic-verify" options={{ headerShown: false }} />
      <Stack.Screen name="admin/verifications" options={{ headerShown: false }} />
      <Stack.Screen name="admin/quick-create" options={{ headerShown: false, presentation: 'modal' }} />
      <Stack.Screen name="membership" options={{ headerShown: false, presentation: 'modal' }} />
      <Stack.Screen name="notifications" options={{ headerShown: false }} />
      <Stack.Screen name="leaderboard" options={{ headerShown: false }} />
      <Stack.Screen name="support" options={{ headerShown: false }} />
      <Stack.Screen name="legal/[type]" options={{ headerShown: false }} />
      <Stack.Screen name="settings" options={{ headerShown: false }} />
      <Stack.Screen name="blocked-users" options={{ headerShown: false }} />
      <Stack.Screen name="matchmaking/index" options={{ headerShown: false }} />
      <Stack.Screen name="profile/[id]" options={{ headerShown: false }} />
    </Stack>
      </RealtimeProvider>
    </ErrorBoundary>
  );
}