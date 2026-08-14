import {
  DEFAULT_TIMEZONE,
  localToUtc,
  slotEndInstant,
  slotStartInstant,
  toDateString,
  toMysqlDateTime,
  toTimeString,
} from '../../utils/slotTime';

describe('slotTime', () => {
  describe('localToUtc', () => {
    it('converts a CEST summer evening slot (UTC+2)', () => {
      // 14 Aug 2026, 19:00 in Berlin is 17:00 UTC.
      expect(localToUtc('2026-08-14', '19:00:00').toISOString()).toBe('2026-08-14T17:00:00.000Z');
    });

    it('converts a CET winter evening slot (UTC+1)', () => {
      // 14 Jan 2026, 19:00 in Berlin is 18:00 UTC.
      expect(localToUtc('2026-01-14', '19:00:00').toISOString()).toBe('2026-01-14T18:00:00.000Z');
    });

    it('is the bug this module exists for: naive parsing is two hours off in summer', () => {
      const naive = new Date('2026-08-14T19:00:00Z');
      const correct = localToUtc('2026-08-14', '19:00:00');
      expect(naive.getTime() - correct.getTime()).toBe(2 * 60 * 60 * 1000);
    });

    it('handles the spring-forward boundary', () => {
      // Clocks jump 02:00 -> 03:00 on 29 Mar 2026. 01:30 is still CET (+1).
      expect(localToUtc('2026-03-29', '01:30:00').toISOString()).toBe('2026-03-29T00:30:00.000Z');
      // 04:00 is already CEST (+2).
      expect(localToUtc('2026-03-29', '04:00:00').toISOString()).toBe('2026-03-29T02:00:00.000Z');
    });

    it('handles the autumn fall-back boundary', () => {
      // Clocks fall 03:00 -> 02:00 on 25 Oct 2026. 01:30 is still CEST (+2).
      expect(localToUtc('2026-10-25', '01:30:00').toISOString()).toBe('2026-10-24T23:30:00.000Z');
      // 04:00 is CET (+1).
      expect(localToUtc('2026-10-25', '04:00:00').toISOString()).toBe('2026-10-25T03:00:00.000Z');
    });

    it('resolves the repeated hour to its first occurrence', () => {
      // 02:30 exists twice on 25 Oct 2026; we take the CEST one (+2).
      expect(localToUtc('2026-10-25', '02:30:00').toISOString()).toBe('2026-10-25T00:30:00.000Z');
    });

    it('shifts a skipped local time forward out of the gap', () => {
      // 02:30 does not exist on 29 Mar 2026 — clocks jump 02:00 -> 03:00.
      // The slot lands at 03:30 CEST rather than vanishing.
      expect(localToUtc('2026-03-29', '02:30:00').toISOString()).toBe('2026-03-29T01:30:00.000Z');
    });

    it('respects a non-German venue timezone', () => {
      expect(localToUtc('2026-08-14', '19:00:00', 'Europe/London').toISOString()).toBe(
        '2026-08-14T18:00:00.000Z'
      );
      expect(localToUtc('2026-08-14', '19:00:00', 'UTC').toISOString()).toBe(
        '2026-08-14T19:00:00.000Z'
      );
    });

    it('accepts a Date for slot_date and HH:MM for slot_start', () => {
      const asDate = new Date('2026-08-14T00:00:00Z');
      expect(localToUtc(asDate, '19:00').toISOString()).toBe('2026-08-14T17:00:00.000Z');
    });

    it('rejects an unparsable pair', () => {
      expect(() => localToUtc('not-a-date', '19:00:00')).toThrow(/Invalid slot date\/time/);
    });

    it('defaults to Europe/Berlin', () => {
      expect(localToUtc('2026-08-14', '19:00:00').getTime()).toBe(
        localToUtc('2026-08-14', '19:00:00', DEFAULT_TIMEZONE).getTime()
      );
    });
  });

  describe('slotStartInstant / slotEndInstant', () => {
    it('prefers the stored absolute instant', () => {
      const slot = {
        starts_at_utc: '2026-08-14 17:00:00',
        slot_date: '2026-08-14',
        slot_start: '99:00:00',
      };
      expect(slotStartInstant(slot).toISOString()).toBe('2026-08-14T17:00:00.000Z');
    });

    it('treats a zone-less stored DATETIME string as UTC', () => {
      // The connection is pinned to UTC, so the string is already the
      // instant — parsing it in the server's local zone would shift it.
      const slot = {
        starts_at_utc: '2026-08-14 17:00:00',
        slot_date: '2026-08-14',
        slot_start: '19:00:00',
      };
      expect(slotStartInstant(slot).toISOString()).toBe('2026-08-14T17:00:00.000Z');
    });

    it('falls back to conversion for rows the backfill has not reached', () => {
      const slot = { starts_at_utc: null, slot_date: '2026-08-14', slot_start: '19:00:00' };
      expect(slotStartInstant(slot).toISOString()).toBe('2026-08-14T17:00:00.000Z');
    });

    it('resolves the end instant the same way', () => {
      const slot = { ends_at_utc: null, slot_date: '2026-08-14', slot_end: '20:30:00' };
      expect(slotEndInstant(slot).toISOString()).toBe('2026-08-14T18:30:00.000Z');
    });

    it('honours the venue timezone on fallback', () => {
      const slot = { starts_at_utc: null, slot_date: '2026-08-14', slot_start: '19:00:00' };
      expect(slotStartInstant(slot, 'UTC').toISOString()).toBe('2026-08-14T19:00:00.000Z');
    });
  });

  describe('normalisers', () => {
    it('reads DATE columns without shifting the calendar day', () => {
      expect(toDateString(new Date('2026-08-14T00:00:00Z'))).toBe('2026-08-14');
      expect(toDateString('2026-08-14T22:00:00.000Z')).toBe('2026-08-14');
      expect(toDateString('2026-08-14')).toBe('2026-08-14');
    });

    it('pads HH:MM to HH:MM:SS and trims fractional seconds', () => {
      expect(toTimeString('19:00')).toBe('19:00:00');
      expect(toTimeString('19:00:00')).toBe('19:00:00');
      expect(toTimeString('19:00:00.000')).toBe('19:00:00');
    });

    it('formats a Date for a MariaDB DATETIME column', () => {
      expect(toMysqlDateTime(new Date('2026-08-14T17:00:00.000Z'))).toBe('2026-08-14 17:00:00');
    });
  });
});
