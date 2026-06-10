/**
 * bookingStore — court bookings made through Tourneo's in-app flow.
 *
 * The store keeps a single source of truth for "Meine Buchungen" so the
 * availability screen and the bookings tab stay in sync after a book or
 * cancel without re-fetching. Optimistic updates are intentionally not
 * used here: a slot lock decision belongs to the server.
 */
import { create } from 'zustand';
import { bookSlot, cancelBooking, listMyBookings, type CourtBooking } from '../api/v2';

interface BookingState {
  bookings: CourtBooking[];
  loading: boolean;
  error: string | null;

  fetchMine: (opts?: { upcomingOnly?: boolean }) => Promise<void>;
  book: (slotId: number, notes?: string) => Promise<CourtBooking>;
  cancel: (bookingId: number) => Promise<void>;
  reset: () => void;
}

export const useBookingStore = create<BookingState>((set, get) => ({
  bookings: [],
  loading: false,
  error: null,

  fetchMine: async (opts) => {
    set({ loading: true, error: null });
    try {
      const data = await listMyBookings(opts);
      set({ bookings: data, loading: false });
    } catch (err: any) {
      const msg =
        err?.response?.data?.error?.message || 'Buchungen konnten nicht geladen werden.';
      set({ loading: false, error: msg });
    }
  },

  book: async (slotId, notes) => {
    const booking = await bookSlot(slotId, notes);
    // Prepend so the new booking shows up first in "Meine Buchungen"
    set({ bookings: [booking, ...get().bookings] });
    return booking;
  },

  cancel: async (bookingId) => {
    await cancelBooking(bookingId);
    set({
      bookings: get().bookings.map((b) =>
        b.id === bookingId
          ? { ...b, status: 'cancelled', cancelled_at: new Date().toISOString() }
          : b
      ),
    });
  },

  reset: () => set({ bookings: [], loading: false, error: null }),
}));
