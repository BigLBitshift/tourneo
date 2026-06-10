import { useBookingStore } from './bookingStore';
import { useCheckoutStore } from './checkoutStore';
import { useCommunityStore } from './communityStore';
import { useEventStore } from './eventStore';
import { useFavoritesStore } from './favoritesStore';
import { useMembershipStore } from './membershipStore';
import { useNotificationStore } from './notificationStore';
import { useRatingStore } from './ratingStore';
import { useRegistrationStore } from './registrationStore';
import { useVenueStore } from './venueStore';

/**
 * Clears all user-specific data from every store after logout so a
 * subsequent login as a different user does not leak cached data
 * (events, favorites, notifications, checkout session, registrations,
 * etc.). Called from authStore.logout().
 *
 * Lives in its own module to avoid the circular import that would
 * otherwise form between authStore and store/index.ts (which re-
 * exports authStore alongside the other stores).
 */
export async function resetAllUserStores(): Promise<void> {
  useBookingStore.getState().reset();
  useCheckoutStore.getState().reset();
  useCommunityStore.getState().reset();
  useEventStore.getState().reset();
  useMembershipStore.getState().reset();
  useNotificationStore.getState().reset();
  useRatingStore.getState().reset();
  useRegistrationStore.getState().reset();
  useVenueStore.getState().reset();
  // Favorites are persisted in AsyncStorage; reset() clears both.
  await useFavoritesStore.getState().reset();
}
