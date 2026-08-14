/**
 * Slot time conversion.
 *
 * Court slots are stored the way a club thinks about them — a local date
 * and a wall-clock time ("2026-08-14", "19:00:00") — but every comparison
 * the backend makes is against an absolute instant: is this slot in the
 * past, does this hold expire in 10 minutes, which slots start in the next
 * two hours. The DB connection is pinned to UTC (`config/database.ts`), so
 * naively reading the pair back produces a time that is one or two hours
 * wrong in Germany depending on the season.
 *
 * These helpers convert between the two representations using the IANA
 * timezone recorded on the venue. They deliberately do not use MySQL's
 * `CONVERT_TZ`, which returns NULL unless the server's timezone tables
 * were populated with `mysql_tzinfo_to_sql` — a dependency that fails
 * silently and is not present on managed MariaDB by default.
 */

export const DEFAULT_TIMEZONE = 'Europe/Berlin';

/**
 * Offset of `timeZone` from UTC at the given instant, in minutes.
 * Positive east of Greenwich — Europe/Berlin is +60 in winter, +120 in summer.
 */
function offsetMinutesAt(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
  }).formatToParts(instant);

  const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  // "GMT+02:00" | "GMT-05:30" | "GMT" (exactly UTC)
  const match = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
  if (!match) return 0;

  const sign = match[1] === '-' ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? 0);
  return sign * (hours * 60 + minutes);
}

/** Normalises the many shapes a DATE column comes back as to `YYYY-MM-DD`. */
export function toDateString(slotDate: string | Date): string {
  if (slotDate instanceof Date) {
    // The driver hands back a Date at UTC midnight for DATE columns;
    // reading UTC parts avoids shifting the calendar day.
    const y = slotDate.getUTCFullYear();
    const m = String(slotDate.getUTCMonth() + 1).padStart(2, '0');
    const d = String(slotDate.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(slotDate).slice(0, 10);
}

/** Normalises a TIME column to `HH:MM:SS`. */
export function toTimeString(slotTime: string | Date): string {
  if (slotTime instanceof Date) {
    const h = String(slotTime.getUTCHours()).padStart(2, '0');
    const m = String(slotTime.getUTCMinutes()).padStart(2, '0');
    const s = String(slotTime.getUTCSeconds()).padStart(2, '0');
    return `${h}:${m}:${s}`;
  }
  const raw = String(slotTime);
  return raw.length === 5 ? `${raw}:00` : raw.slice(0, 8);
}

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

/**
 * Converts a venue-local date + wall-clock time into the absolute instant.
 *
 * A wall clock does not map one-to-one onto instants around a DST
 * transition, so both offsets in effect on that day are considered and
 * each candidate instant is verified by converting it back:
 *
 *   - Normal times produce exactly one valid candidate.
 *   - Ambiguous times (the hour that repeats when clocks go back) produce
 *     two; the earlier one wins, so 02:30 on transition night is still
 *     summer time — the first time the club's clock reads 02:30.
 *   - Non-existent times (the hour skipped when clocks go forward)
 *     produce none, and the wall clock is shifted forward by the gap, so
 *     02:30 becomes 03:30. A club that wrote 02:30 into its schedule
 *     meant "right after 01:59", not "cancel this slot".
 */
export function localToUtc(
  slotDate: string | Date,
  slotTime: string | Date,
  timeZone: string = DEFAULT_TIMEZONE
): Date {
  const dateStr = toDateString(slotDate);
  const timeStr = toTimeString(slotTime);

  // Interpret the wall clock as if it were UTC; the true instant is that
  // value minus whichever offset is actually in effect there.
  const naive = new Date(`${dateStr}T${timeStr}Z`);
  if (Number.isNaN(naive.getTime())) {
    throw new Error(`Invalid slot date/time: ${dateStr} ${timeStr}`);
  }

  // Probing half a day either side brackets any transition near this time
  // while staying well inside the same offset for ordinary timestamps.
  const offsetBefore = offsetMinutesAt(new Date(naive.getTime() - TWELVE_HOURS_MS), timeZone);
  const offsetAfter = offsetMinutesAt(new Date(naive.getTime() + TWELVE_HOURS_MS), timeZone);

  const valid: Date[] = [];
  for (const offset of new Set([offsetBefore, offsetAfter])) {
    const candidate = new Date(naive.getTime() - offset * 60_000);
    // Round-trip check: does this instant really read as the requested
    // wall clock in that zone?
    if (offsetMinutesAt(candidate, timeZone) === offset) valid.push(candidate);
  }

  if (valid.length > 0) {
    return valid.reduce((earliest, c) => (c < earliest ? c : earliest));
  }

  // Skipped hour — apply the pre-transition offset, which lands the slot
  // just after the gap rather than before it.
  return new Date(naive.getTime() - offsetBefore * 60_000);
}

/**
 * Reads a slot's start instant, preferring the stored absolute value and
 * falling back to conversion for rows the backfill has not reached yet.
 */
export function slotStartInstant(
  slot: {
    starts_at_utc?: string | Date | null;
    slot_date: string | Date;
    slot_start: string | Date;
  },
  timeZone: string = DEFAULT_TIMEZONE
): Date {
  if (slot.starts_at_utc) {
    const stored = asUtcDate(slot.starts_at_utc);
    if (stored) return stored;
  }
  return localToUtc(slot.slot_date, slot.slot_start, timeZone);
}

/** Same as `slotStartInstant` for the end of the slot. */
export function slotEndInstant(
  slot: {
    ends_at_utc?: string | Date | null;
    slot_date: string | Date;
    slot_end: string | Date;
  },
  timeZone: string = DEFAULT_TIMEZONE
): Date {
  if (slot.ends_at_utc) {
    const stored = asUtcDate(slot.ends_at_utc);
    if (stored) return stored;
  }
  return localToUtc(slot.slot_date, slot.slot_end, timeZone);
}

/**
 * A DATETIME column read back from a UTC-pinned connection is already the
 * correct instant, but mysql2 may hand it over as a Date or as a string
 * without a zone designator — the latter would otherwise be parsed in the
 * server's local zone.
 */
function asUtcDate(value: string | Date): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const raw = String(value).trim();
  const normalised = /[Zz]|[+-]\d{2}:?\d{2}$/.test(raw)
    ? raw.replace(' ', 'T')
    : `${raw.replace(' ', 'T')}Z`;
  const parsed = new Date(normalised);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Formats a Date for a MariaDB DATETIME column on a UTC connection. */
export function toMysqlDateTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}
