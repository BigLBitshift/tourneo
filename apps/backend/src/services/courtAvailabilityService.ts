import { db, t } from '../config/database';
import { DEFAULT_TIMEZONE, localToUtc, toMysqlDateTime } from '../utils/slotTime';

export type SlotStatus = 'available' | 'held' | 'booked' | 'blocked';

/**
 * Where a slot's information came from. The UI renders `venue` and
 * `import` slots as bookable and everything else as "probably free — ask
 * the club", so coverage can grow without the app claiming more certainty
 * than it has.
 */
export type SlotSource = 'venue' | 'import' | 'assumed' | 'crowd' | 'admin';

export interface AvailabilitySlot {
  id: number;
  venue_id: number;
  court_id: number | null;
  slot_date: string;
  slot_start: string;
  slot_end: string;
  starts_at_utc: string | Date | null;
  ends_at_utc: string | Date | null;
  status: SlotStatus;
  source: SlotSource;
  confidence: number;
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
 *
 * Every write also records the slot's absolute start/end instant, resolved
 * through the venue's timezone. Slot times are stored as the club's wall
 * clock, which is what a club can maintain, but every comparison the rest
 * of the system makes — is this in the past, does this hold expire soon —
 * needs a real instant. See `utils/slotTime.ts`.
 */
export class CourtAvailabilityService {
  /** Reads a venue's IANA timezone, falling back to Europe/Berlin. */
  private static async venueTimezone(venueId: number): Promise<string> {
    const venue = await db(t('venues')).where('id', venueId).select('timezone').first();
    return venue?.timezone || DEFAULT_TIMEZONE;
  }
  /**
   * List available slots for a venue on a given date (or date range).
   */
  static async listForVenue(
    venueId: number,
    opts: {
      fromDate?: string;
      toDate?: string;
      courtId?: number;
      statusFilter?: SlotStatus;
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
    status?: SlotStatus;
    source?: SlotSource;
    confidence?: number;
    price_cents?: number | null;
    booking_url?: string | null;
  }): Promise<number> {
    const now = new Date();
    const timezone = await this.venueTimezone(slot.venue_id);

    const existing = await db(t('court_availability'))
      .where('venue_id', slot.venue_id)
      .where('court_id', slot.court_id ?? null)
      .where('slot_date', slot.slot_date)
      .where('slot_start', slot.slot_start)
      .first();

    const instants = {
      starts_at_utc: toMysqlDateTime(localToUtc(slot.slot_date, slot.slot_start, timezone)),
      ends_at_utc: toMysqlDateTime(localToUtc(slot.slot_date, slot.slot_end, timezone)),
    };

    if (existing) {
      await db(t('court_availability'))
        .where('id', existing.id)
        .update({
          slot_end: slot.slot_end,
          ...instants,
          status: slot.status ?? 'available',
          source: slot.source ?? 'admin',
          confidence: slot.confidence ?? 100,
          price_cents: slot.price_cents ?? null,
          booking_url: slot.booking_url ?? null,
          version: db.raw('version + 1'),
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
      ...instants,
      status: slot.status ?? 'available',
      source: slot.source ?? 'admin',
      confidence: slot.confidence ?? 100,
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
    source?: SlotSource;
  }): Promise<number> {
    if (!Number.isFinite(params.slot_duration_minutes) || params.slot_duration_minutes <= 0) {
      throw new Error('slot_duration_minutes must be a positive number');
    }
    // Calendar arithmetic runs at UTC midnight throughout. Building the
    // cursor from a local-midnight Date and reading it back with
    // toISOString() shifts the calendar day for any server west of UTC.
    const fromDate = new Date(`${String(params.from_date).slice(0, 10)}T00:00:00Z`);
    const toDate = new Date(`${String(params.to_date).slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      throw new Error('Invalid from_date / to_date');
    }
    if (toDate < fromDate) {
      throw new Error('to_date must be on or after from_date');
    }

    const startMinutes = parseHhMm(params.daily_start);
    const endMinutes = parseHhMm(params.daily_end);
    if (endMinutes <= startMinutes) {
      throw new Error('daily_end must be after daily_start');
    }

    const timezone = await this.venueTimezone(params.venue_id);
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

    const priceFor = (weekdayBit: number, hhmmss: string): number | null => {
      for (const rule of rules) {
        if ((rule.weekday_mask & weekdayBit) === 0) continue;
        if (hhmmss >= String(rule.start_time) && hhmmss < String(rule.end_time)) {
          return rule.price_cents;
        }
      }
      return params.price_cents ?? null;
    };

    for (let d = new Date(fromDate); d <= toDate; d.setUTCDate(d.getUTCDate() + 1)) {
      const dateStr = d.toISOString().slice(0, 10);
      // Bitmask: Mon=1 … Sun=64 (getUTCDay(): Sun=0 → bit 64)
      const dow = d.getUTCDay();
      const weekdayBit = dow === 0 ? 64 : 1 << (dow - 1);

      for (
        let startMin = startMinutes;
        startMin + params.slot_duration_minutes <= endMinutes;
        startMin += params.slot_duration_minutes
      ) {
        if (slots.length >= this.MAX_SLOTS_PER_GENERATION) {
          throw new Error(
            `Too many slots requested (max ${this.MAX_SLOTS_PER_GENERATION}); narrow the date range or use a longer slot duration.`
          );
        }
        const slotStart = formatMinutes(startMin);
        const slotEnd = formatMinutes(startMin + params.slot_duration_minutes);

        slots.push({
          venue_id: params.venue_id,
          court_id: params.court_id ?? null,
          slot_date: dateStr,
          slot_start: slotStart,
          slot_end: slotEnd,
          starts_at_utc: toMysqlDateTime(localToUtc(dateStr, slotStart, timezone)),
          ends_at_utc: toMysqlDateTime(localToUtc(dateStr, slotEnd, timezone)),
          status: 'available',
          source: params.source ?? 'admin',
          confidence: 100,
          price_cents: priceFor(weekdayBit, slotStart),
          booking_url: params.booking_url ?? null,
          created_at: now,
          updated_at: now,
        });
      }
    }

    if (slots.length === 0) return 0;

    // Idempotent by design: re-running a generation over an overlapping
    // range must refresh those slots, never duplicate them. Migration 018
    // added the unique key this relies on. Booked, held and blocked slots
    // are deliberately left alone — a regenerate must not silently free a
    // court someone already reserved.
    await db.raw(
      `INSERT INTO \`${t('court_availability')}\`
         (venue_id, court_id, slot_date, slot_start, slot_end, starts_at_utc, ends_at_utc,
          status, source, confidence, price_cents, booking_url, created_at, updated_at)
       VALUES ${slots.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',')}
       ON DUPLICATE KEY UPDATE
         slot_end     = VALUES(slot_end),
         starts_at_utc= VALUES(starts_at_utc),
         ends_at_utc  = VALUES(ends_at_utc),
         source       = VALUES(source),
         confidence   = VALUES(confidence),
         price_cents  = VALUES(price_cents),
         booking_url  = VALUES(booking_url),
         version      = version + 1,
         updated_at   = VALUES(updated_at)`,
      slots.flatMap((s) => [
        s.venue_id,
        s.court_id,
        s.slot_date,
        s.slot_start,
        s.slot_end,
        s.starts_at_utc,
        s.ends_at_utc,
        s.status,
        s.source,
        s.confidence,
        s.price_cents,
        s.booking_url,
        s.created_at,
        s.updated_at,
      ])
    );
    return slots.length;
  }
}

/** `"08:30"` / `"08:30:00"` → minutes since midnight. */
function parseHhMm(value: string): number {
  const [h, m] = String(value).split(':').map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    throw new Error(`Invalid time of day: ${value}`);
  }
  return h * 60 + m;
}

/** Minutes since midnight → `"HH:MM:SS"`. */
function formatMinutes(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
}
