/**
 * checkoutStore – Manages Stripe checkout flow for tournament registration.
 * States: idle → loading → redirecting → success | error | cancelled
 *
 * Flow:
 *   1. Caller passes a registrationId (created via registrationStore.registerForEvent)
 *   2. createCheckoutSession() calls POST /payments/create-intent → returns PaymentIntent
 *   3. openCheckout() opens Stripe Checkout via WebBrowser (or shows the PI client_secret
 *      to a native PaymentSheet when @stripe/stripe-react-native is present)
 *   4. Backend confirms via webhook → registration becomes "confirmed"
 */
import { create } from 'zustand';
import * as WebBrowser from 'expo-web-browser';
import apiClient from '../api/client';

export type CheckoutStatus = 'idle' | 'loading' | 'redirecting' | 'success' | 'error' | 'cancelled';

interface CheckoutSession {
  registrationId: number;
  paymentIntentId: string;
  /** Hosted Stripe Checkout URL — created server-side, never built here. */
  checkoutUrl: string;
  amount: number;
  currency: string;
  free?: boolean;
}

interface CheckoutStoreState {
  status: CheckoutStatus;
  session: CheckoutSession | null;
  error: string | null;

  /**
   * Loads PaymentIntent from backend.
   * If `registrationId` is provided uses it directly,
   * otherwise creates a registration for the given eventId first.
   */
  createCheckoutSession: (eventId: number, registrationId?: number) => Promise<void>;
  openCheckout: () => Promise<void>;
  /** Confirms the real state against our own API. Never infers from a URL. */
  confirmStatus: () => Promise<void>;
  reset: () => void;
}

export const useCheckoutStore = create<CheckoutStoreState>((set, get) => ({
  status: 'idle',
  session: null,
  error: null,

  createCheckoutSession: async (eventId: number, registrationId?: number) => {
    set({ status: 'loading', error: null });
    try {
      // Step 1: Ensure we have a registration
      let regId = registrationId;
      if (!regId) {
        const regResponse = await apiClient.post('/registrations', {
          event_id: eventId,
          registration_type: 'solo',
          consent_tournament_terms: true,
          consent_age_verified: true,
          consent_media: false,
        });
        regId = regResponse.data?.data?.id;
        if (!regId) throw new Error('Konnte Anmeldung nicht erstellen.');
      }

      // Step 2: Ask backend to create the PaymentIntent for this registration
      const response = await apiClient.post('/payments/create-intent', {
        registration_id: regId,
      });
      const data = response.data.data;

      // Free / fully discounted registration → no payment necessary
      if (data.free) {
        set({
          status: 'success',
          session: {
            registrationId: regId!,
            paymentIntentId: '',
            checkoutUrl: '',
            amount: 0,
            currency: 'eur',
            free: true,
          },
        });
        return;
      }

      set({
        status: 'idle',
        session: {
          registrationId: regId!,
          paymentIntentId: data.payment_intent_id,
          checkoutUrl: data.checkout_url,
          amount: data.amount_cents,
          currency: (data.currency || 'EUR').toLowerCase(),
        },
      });
    } catch (error: unknown) {
      const msg = (error as { response?: { data?: { error?: { message?: string } } } })
        ?.response?.data?.error?.message || 'Checkout konnte nicht erstellt werden.';
      set({ status: 'error', error: msg });
    }
  },

  openCheckout: async () => {
    const { session } = get();
    if (!session) {
      set({ status: 'error', error: 'Keine Zahlungsdaten vorhanden.' });
      return;
    }

    // If the session is free we are already done
    if (session.free) {
      set({ status: 'success' });
      return;
    }

    if (!session.checkoutUrl) {
      set({ status: 'error', error: 'Zahlungsseite nicht verfügbar. Bitte erneut versuchen.' });
      return;
    }

    set({ status: 'redirecting' });
    try {
      // The URL comes from the server's Checkout Session. The client used
      // to build one itself by prefixing the PaymentIntent id with `src_`
      // and pointing at the legacy Sources 3DS endpoint, which meant there
      // was never any card entry and never any SCA.
      await WebBrowser.openAuthSessionAsync(session.checkoutUrl, 'tourneo://checkout/callback');

      // Whatever the browser reports — success, cancel, dismissal — the
      // only thing that decides whether this registration is paid is our
      // own record, written by the Stripe webhook.
      await get().confirmStatus();
    } catch {
      set({ status: 'error', error: 'Browser konnte nicht geöffnet werden.' });
    }
  },

  /**
   * Asks the server what actually happened.
   *
   * The previous implementation inspected the return URL and defaulted
   * *unknown* results to success, which confirmed registrations that were
   * never paid for. Payment state is decided by the webhook and read back
   * from the registration; the client never guesses.
   *
   * The webhook may land a moment after the browser closes, so a pending
   * registration is polled briefly before being reported as such.
   */
  confirmStatus: async () => {
    const { session } = get();
    if (!session) return;

    const POLL_ATTEMPTS = 5;
    const POLL_INTERVAL_MS = 1200;

    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
      try {
        const res = await apiClient.get(`/registrations/${session.registrationId}`);
        const status = res.data?.data?.status;

        if (status === 'confirmed' || status === 'waitlisted') {
          set({ status: 'success' });
          return;
        }
        if (status === 'cancelled' || status === 'refunded') {
          set({ status: 'cancelled' });
          return;
        }
      } catch {
        // Network hiccup — keep trying, then fall through to pending.
      }

      if (attempt < POLL_ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    }

    // Still pending. Say so honestly rather than claiming success: if the
    // payment does land, the webhook confirms it and the registration
    // appears; if it does not, the user has not been misled into showing
    // up at a tournament they are not signed up for.
    set({
      status: 'cancelled',
      error:
        'Die Zahlung wurde noch nicht bestätigt. Prüfe in Kürze deine Anmeldungen — bei Fragen melde dich beim Support.',
    });
  },

  reset: () => set({ status: 'idle', session: null, error: null }),
}));
