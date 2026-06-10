import { useBookingStore } from '../store/bookingStore';
import * as v2 from '../api/v2';

jest.mock('../api/v2', () => ({
  bookSlot: jest.fn(),
  cancelBooking: jest.fn(),
  listMyBookings: jest.fn(),
}));

const sampleBooking: v2.CourtBooking = {
  id: 7,
  uuid: 'u-7',
  slot_id: 100,
  venue_id: 1,
  court_id: 2,
  user_id: 42,
  status: 'confirmed',
  price_cents: 1800,
  currency: 'EUR',
  payment_method: 'pay_at_venue',
  notes: null,
  booked_at: '2026-06-10T10:00:00Z',
  cancelled_at: null,
  slot_date: '2026-06-12',
  slot_start: '18:00:00',
  slot_end: '19:30:00',
  venue_name: 'Padel City',
  venue_street: 'Sportplatzweg 10',
  venue_city: 'München',
  court_name: 'Court 2',
};

describe('bookingStore', () => {
  beforeEach(() => {
    useBookingStore.setState({ bookings: [], loading: false, error: null });
    jest.clearAllMocks();
  });

  it('fetchMine populates bookings on success', async () => {
    (v2.listMyBookings as jest.Mock).mockResolvedValue([sampleBooking]);
    await useBookingStore.getState().fetchMine({ upcomingOnly: true });
    expect(useBookingStore.getState().bookings).toHaveLength(1);
    expect(useBookingStore.getState().loading).toBe(false);
    expect(v2.listMyBookings).toHaveBeenCalledWith({ upcomingOnly: true });
  });

  it('fetchMine surfaces server error message', async () => {
    (v2.listMyBookings as jest.Mock).mockRejectedValue({
      response: { data: { error: { message: 'oops' } } },
    });
    await useBookingStore.getState().fetchMine();
    expect(useBookingStore.getState().error).toBe('oops');
  });

  it('book prepends the new booking', async () => {
    (v2.bookSlot as jest.Mock).mockResolvedValue(sampleBooking);
    useBookingStore.setState({
      bookings: [{ ...sampleBooking, id: 1, slot_id: 999 }],
    });
    await useBookingStore.getState().book(100);
    expect(useBookingStore.getState().bookings[0].id).toBe(7);
    expect(useBookingStore.getState().bookings).toHaveLength(2);
  });

  it('cancel flips status without removing the row', async () => {
    (v2.cancelBooking as jest.Mock).mockResolvedValue({ id: 7, status: 'cancelled' });
    useBookingStore.setState({ bookings: [sampleBooking] });
    await useBookingStore.getState().cancel(7);
    expect(useBookingStore.getState().bookings[0].status).toBe('cancelled');
    expect(useBookingStore.getState().bookings[0].cancelled_at).not.toBeNull();
  });
});
