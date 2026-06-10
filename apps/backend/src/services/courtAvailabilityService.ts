import { db, t } from '../config/database';

export interface AvailabilitySlot {
  id: number;
  venue_id: number;
  court_id: number | null;
  slot_date: string;
  slot_start: string;
  slot_end: string;
  status: 'available' | 'booked' | 'blocked';
  price_cents: number | null;
  booking_url: string | null;
}

/**
 * CourtAvailabilityService — Manages court availability slots for venues.
 *
 * Supports:
 *   - Listing availability by venue/date/sport
 *   - Filtering by time range and status
 *   - Admin upsert of slots (for venue managers)
 *   - Bulk generation of recurring slots
 */
export class CourtAvailabilityService {
  /**
   * List available slots for a venue on a given date (or date range).
   */
  static async listForVenue(
    venueId: number,
    opts: {
      fromDate?: string;
      toDate?: string;
      courtId?: number;
      statusFilter?: 'available' | 'booked' | 'blocked';
    } = {},
  ): Promise<AvailabilitySlot[]> {
    let q = db(t('court_availability')).where('venue_id', venueId);

    if (opts.fromDate) q = q.where('slot_date', '>=', opts.fromDate);
    if (opts.toDate) q = q.where('slot_date', '<=', opts.toDate);
    if (opts.courtId) q = q.where('court_id', opts.courtId);
    if (opts.statusFilter) q = q.where('status', opts.statusFilter);

    return q.orderBy('slot_date', 'asc').orderBy('slot_start', 'asc');
  }

  /**
   * Create or update a single slot.
   */
  static async upsertSlot(slot: {
    venue_id: number;
    court_id?: number | null;
    slot_date: string;
    slot_start: string;
    slot_end: string;
    status?: 'available' | 'booked' | 'blocked';
    price_cents?: number | null;
    booking_url?: string | null;
  }): Promise<number> {
    const now = new Date();
    const existing = await db(t('court_availability'))
      .where('venue_id', slot.venue_id)
      .where('court_id', slot.court_id ?? null)
      .where('slot_date', slot.slot_date)
      .where('slot_start', slot.slot_start)
      .first();

    if (existing) {
      await db(t('court_availability'))
        .where('id', existing.id)
        .update({
          slot_end: slot.slot_end,
          status: slot.status ?? 'available',
          price_cents: slot.price_cents ?? null,
          booking_url: slot.booking_url ?? null,
          updated_at: now,
        });
      return existing.id;
    }

    const [id] = await db(t('court_availability')).insert({
      venue_id: slot.venue_id,
      court_id: slot.court_id ?? null,
      slot_date: slot.slot_date,
      slot_start: slot.slot_start,
      slot_end: slot.slot_end,
      status: slot.status ?? 'available',
      price_cents: slot.price_cents ?? null,
      booking_url: slot.booking_url ?? null,
      created_at: now,
      updated_at: now,
    });
    return id;
  }

  /**
   * Generate recurring slots for a venue (e.g. every 90 min, 8:00–22:00 daily).
   *
   * Hard-caps the number of generated rows so a misconfigured request
   * (e.g. from_date 2024-01-01, to_date 2030-01-01, slot_duration 1) can
   * never blow up memory or hammer the DB.
   */
  private static readonly MAX_SLOTS_PER_GENERATION = 5000;

  static async generateRecurring(params: {
    venue_id: number;
    court_id?: number | null;
    from_date: string;
    to_date: string;
    daily_start: string;
    daily_end: string;
    slot_duration_minutes: number;
    price_cents?: number;
    booking_url?: string;
  }): Promise<number> {
    if (!Number.isFinite(params.slot_duration_minutes) || params.slot_duration_minutes <= 0) {
      throw new Error('slot_duration_minutes must be a positive number');
    }
    const fromDate = new Date(params.from_date);
    const toDate = new Date(params.to_date);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      throw new Error('Invalid from_date / to_date');
    }
    if (toDate < fromDate) {
      throw new Error('to_date must be on or after from_date');
    }
    const now = new Date();
    const slots: any[] = [];

    // Dynamic pricing: per-venue rules (weekday bitmask + time window)
    // override the flat price. First matching active rule wins; without a
    // match the flat params.price_cents applies. Lets clubs make off-peak
    // slots cheaper and prime time pricier.
    const rules: Array<{
      weekday_mask: number;
      start_time: string;
      end_time: string;
      price_cents: number;
    }> = await db(t('pricing_rules'))
      .where('venue_id', params.venue_id)
      .where('is_active', true)
      .orderBy('id', 'asc')
      .select('weekday_mask', 'start_time', 'end_time', 'price_cents');

    const priceFor = (slotStart: Date): number | null => {
      // Bitmask: Mon=1 … Sun=64 (getDay(): Sun=0 → bit 64)
      const dow = slotStart.getDay();
      const bit = dow === 0 ? 64 : 1 << (dow - 1);
      const hhmm = `${String(slotStart.getHours()).padStart(2, '0')}:${String(slotStart.getMinutes()).padStart(2, '0')}:00`;
      for (const rule of rules) {
        if ((rule.weekday_mask & bit) === 0) continue;
        if (hhmm >= String(rule.start_time) && hhmm < String(rule.end_time)) {
          return rule.price_cents;
        }
      }
      return params.price_cents ?? null;
    };

    for (let d = new Date(fromDate); d <= toDate; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().slice(0, 10);
      const [startH, startM] = params.daily_start.split(':').map(Number);
      const [endH, endM] = params.daily_end.split(':').map(Number);
      const dayStart = new Date(d);
      dayStart.setHours(startH, startM, 0, 0);
      const dayEnd = new Date(d);
      dayEnd.setHours(endH, endM, 0, 0);

      for (
        let slotStart = new Date(dayStart);
        slotStart.getTime() + params.slot_duration_minutes * 60000 <= dayEnd.getTime();
        slotStart = new Date(slotStart.getTime() + params.slot_duration_minutes * 60000)
      ) {
        if (slots.length >= this.MAX_SLOTS_PER_GENERATION) {
          throw new Error(
            `Too many slots requested (max ${this.MAX_SLOTS_PER_GENERATION}); narrow the date range or use a longer slot duration.`
          );
        }
        const slotEnd = new Date(slotStart.getTime() + params.slot_duration_minutes * 60000);
        slots.push({
          venue_id: params.venue_id,
          court_id: params.court_id ?? null,
          slot_date: dateStr,
          slot_start: this.formatTime(slotStart),
          slot_end: this.formatTime(slotEnd),
          status: 'available',
          price_cents: priceFor(slotStart),
          booking_url: params.booking_url ?? null,
          created_at: now,
          updated_at: now,
        });
      }
    }

    if (slots.length === 0) return 0;
    await db(t('court_availability')).insert(slots);
    return slots.length;
  }

  private static formatTime(d: Date): string {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:00`;
  }
}
