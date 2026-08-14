/**
 * Slot generation is pure arithmetic over a mocked DB: the query builder
 * is stubbed so the tests can assert on exactly what would be written,
 * without a live MariaDB. The behaviours pinned here — no duplicate slots,
 * no calendar drift, correct UTC instants — are the three things a live
 * queue on top of these rows silently depends on.
 */
const rawCalls: Array<{ sql: string; bindings: unknown[] }> = [];
let pricingRules: Array<{
  weekday_mask: number;
  start_time: string;
  end_time: string;
  price_cents: number;
}> = [];
let venueTimezone: string | null = 'Europe/Berlin';

jest.mock('../../config/database', () => {
  const dbFn: any = jest.fn((table: string) => {
    if (table === 'tourneo_venues') {
      return {
        where: () => ({
          select: () => ({ first: async () => ({ timezone: venueTimezone }) }),
        }),
      };
    }
    if (table === 'tourneo_pricing_rules') {
      return {
        where: () => ({
          where: () => ({
            orderBy: () => ({ select: async () => pricingRules }),
          }),
        }),
      };
    }
    throw new Error(`unexpected table: ${table}`);
  });
  dbFn.raw = jest.fn(async (sql: string, bindings: unknown[]) => {
    rawCalls.push({ sql, bindings });
    return [{ affectedRows: 0 }];
  });
  return { db: dbFn, t: (name: string) => `tourneo_${name}` };
});

import { CourtAvailabilityService } from '../../services/courtAvailabilityService';

/** Re-hydrates the flat bindings array back into slot rows. */
function insertedSlots() {
  expect(rawCalls).toHaveLength(1);
  const COLUMNS = 14;
  const { bindings } = rawCalls[0];
  const rows = [];
  for (let i = 0; i < bindings.length; i += COLUMNS) {
    const [
      venue_id,
      court_id,
      slot_date,
      slot_start,
      slot_end,
      starts_at_utc,
      ends_at_utc,
      status,
      source,
      confidence,
      price_cents,
    ] = bindings.slice(i, i + COLUMNS);
    rows.push({
      venue_id,
      court_id,
      slot_date,
      slot_start,
      slot_end,
      starts_at_utc,
      ends_at_utc,
      status,
      source,
      confidence,
      price_cents,
    });
  }
  return rows;
}

const BASE = {
  venue_id: 1,
  from_date: '2026-08-14',
  to_date: '2026-08-14',
  daily_start: '18:00',
  daily_end: '21:00',
  slot_duration_minutes: 90,
};

describe('CourtAvailabilityService.generateRecurring', () => {
  beforeEach(() => {
    rawCalls.length = 0;
    pricingRules = [];
    venueTimezone = 'Europe/Berlin';
  });

  it('generates whole slots only and never overruns daily_end', async () => {
    const count = await CourtAvailabilityService.generateRecurring({
      ...BASE,
      daily_end: '21:30',
    });
    expect(count).toBe(2);
    const slots = insertedSlots();
    expect(slots.map((s) => [s.slot_start, s.slot_end])).toEqual([
      ['18:00:00', '19:30:00'],
      ['19:30:00', '21:00:00'],
    ]);
  });

  it('records the absolute UTC instant for each slot in summer time', async () => {
    await CourtAvailabilityService.generateRecurring(BASE);
    const slots = insertedSlots();
    // 18:00 Berlin in August is 16:00 UTC.
    expect(slots[0].starts_at_utc).toBe('2026-08-14 16:00:00');
    expect(slots[0].ends_at_utc).toBe('2026-08-14 17:30:00');
  });

  it('records a one-hour offset in winter time', async () => {
    await CourtAvailabilityService.generateRecurring({
      ...BASE,
      from_date: '2026-01-14',
      to_date: '2026-01-14',
    });
    const slots = insertedSlots();
    expect(slots[0].starts_at_utc).toBe('2026-01-14 17:00:00');
  });

  it('honours a non-default venue timezone', async () => {
    venueTimezone = 'UTC';
    await CourtAvailabilityService.generateRecurring(BASE);
    expect(insertedSlots()[0].starts_at_utc).toBe('2026-08-14 18:00:00');
  });

  it('falls back to Europe/Berlin when the venue has no timezone', async () => {
    venueTimezone = null;
    await CourtAvailabilityService.generateRecurring(BASE);
    expect(insertedSlots()[0].starts_at_utc).toBe('2026-08-14 16:00:00');
  });

  it('does not drift the calendar day across a multi-day range', async () => {
    const count = await CourtAvailabilityService.generateRecurring({
      ...BASE,
      from_date: '2026-08-14',
      to_date: '2026-08-16',
      daily_end: '19:30',
    });
    expect(count).toBe(3);
    expect(insertedSlots().map((s) => s.slot_date)).toEqual([
      '2026-08-14',
      '2026-08-15',
      '2026-08-16',
    ]);
  });

  it('upserts rather than inserts, so a repeated run cannot duplicate slots', async () => {
    await CourtAvailabilityService.generateRecurring(BASE);
    expect(rawCalls[0].sql).toContain('ON DUPLICATE KEY UPDATE');
    // A regenerate must not free a court somebody already reserved.
    expect(rawCalls[0].sql).not.toContain('status       = VALUES(status)');
  });

  it('applies a matching pricing rule and falls back to the flat price', async () => {
    pricingRules = [
      { weekday_mask: 127, start_time: '19:00:00', end_time: '23:00:00', price_cents: 3600 },
    ];
    await CourtAvailabilityService.generateRecurring({ ...BASE, price_cents: 2400 });
    const slots = insertedSlots();
    expect(slots[0].price_cents).toBe(2400); // 18:00 — outside the rule
    expect(slots[1].price_cents).toBe(3600); // 19:30 — inside the rule
  });

  it('matches pricing rules against the correct weekday', async () => {
    // 2026-08-14 is a Friday → bit 16. A Monday-only rule must not match.
    pricingRules = [
      { weekday_mask: 1, start_time: '00:00:00', end_time: '23:59:59', price_cents: 9900 },
    ];
    await CourtAvailabilityService.generateRecurring({ ...BASE, price_cents: 2400 });
    expect(insertedSlots()[0].price_cents).toBe(2400);

    rawCalls.length = 0;
    pricingRules = [
      { weekday_mask: 16, start_time: '00:00:00', end_time: '23:59:59', price_cents: 9900 },
    ];
    await CourtAvailabilityService.generateRecurring({ ...BASE, price_cents: 2400 });
    expect(insertedSlots()[0].price_cents).toBe(9900);
  });

  it('defaults new slots to available with admin provenance', async () => {
    await CourtAvailabilityService.generateRecurring(BASE);
    const slot = insertedSlots()[0];
    expect(slot.status).toBe('available');
    expect(slot.source).toBe('admin');
    expect(slot.confidence).toBe(100);
  });

  it('records the requested provenance so imported slots stay distinguishable', async () => {
    await CourtAvailabilityService.generateRecurring({ ...BASE, source: 'import' });
    expect(insertedSlots()[0].source).toBe('import');
  });

  it('writes nothing when the window is too short for a single slot', async () => {
    const count = await CourtAvailabilityService.generateRecurring({
      ...BASE,
      daily_end: '19:00',
      slot_duration_minutes: 90,
    });
    expect(count).toBe(0);
    expect(rawCalls).toHaveLength(0);
  });

  it('rejects invalid input rather than writing garbage', async () => {
    await expect(
      CourtAvailabilityService.generateRecurring({ ...BASE, slot_duration_minutes: 0 })
    ).rejects.toThrow(/positive number/);

    await expect(
      CourtAvailabilityService.generateRecurring({ ...BASE, to_date: '2026-08-13' })
    ).rejects.toThrow(/on or after/);

    await expect(
      CourtAvailabilityService.generateRecurring({ ...BASE, daily_end: '18:00' })
    ).rejects.toThrow(/daily_end must be after/);

    await expect(
      CourtAvailabilityService.generateRecurring({ ...BASE, daily_start: '25:00' })
    ).rejects.toThrow(/Invalid time of day/);

    expect(rawCalls).toHaveLength(0);
  });

  it('caps runaway generations instead of exhausting memory', async () => {
    await expect(
      CourtAvailabilityService.generateRecurring({
        ...BASE,
        from_date: '2026-01-01',
        to_date: '2030-01-01',
        daily_start: '00:00',
        daily_end: '23:00',
        slot_duration_minutes: 30,
      })
    ).rejects.toThrow(/Too many slots/);
  });
});
