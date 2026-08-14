/**
 * One-shot backfill of `court_availability.starts_at_utc` / `ends_at_utc`
 * for rows that predate migration 018.
 *
 * Run once after migrating:
 *   npm run backfill:slots --workspace=apps/backend
 *
 * Idempotent and resumable — it only touches rows where `starts_at_utc IS
 * NULL`, so an interrupted run can simply be repeated. Pages through the
 * table so a venue with a year of 30-minute slots does not load into
 * memory all at once.
 *
 * The conversion runs in Node rather than via SQL `CONVERT_TZ`, which
 * returns NULL unless the server's timezone tables were populated with
 * `mysql_tzinfo_to_sql`. On managed MariaDB they usually are not, and the
 * failure is silent: every row would be written as NULL and every later
 * comparison would fall back to the wrong wall-clock time.
 */
import { db, t } from '../config/database';
import { DEFAULT_TIMEZONE, localToUtc, toMysqlDateTime } from '../utils/slotTime';

const PAGE_SIZE = 5000;

export async function backfillSlotInstants(): Promise<{ updated: number; skipped: number }> {
  const venues: Array<{ id: number; timezone: string | null }> = await db(t('venues')).select(
    'id',
    'timezone'
  );
  const timezoneOf = new Map(venues.map((v) => [v.id, v.timezone || DEFAULT_TIMEZONE]));

  let updated = 0;
  let skipped = 0;
  let lastId = 0;

  for (;;) {
    const page = await db(t('court_availability'))
      .whereNull('starts_at_utc')
      .where('id', '>', lastId)
      .orderBy('id', 'asc')
      .limit(PAGE_SIZE)
      .select('id', 'venue_id', 'slot_date', 'slot_start', 'slot_end');

    if (page.length === 0) break;
    lastId = page[page.length - 1].id;

    // Grouped by (starts, ends) so a page of 5000 slots becomes a handful
    // of UPDATE … WHERE id IN (…) statements instead of 5000 round trips.
    const groups = new Map<string, { starts: string; ends: string; ids: number[] }>();

    for (const row of page) {
      const timezone = timezoneOf.get(row.venue_id) ?? DEFAULT_TIMEZONE;
      try {
        const starts = toMysqlDateTime(localToUtc(row.slot_date, row.slot_start, timezone));
        const ends = toMysqlDateTime(localToUtc(row.slot_date, row.slot_end, timezone));
        const key = `${starts}|${ends}`;
        const group = groups.get(key);
        if (group) group.ids.push(row.id);
        else groups.set(key, { starts, ends, ids: [row.id] });
      } catch (err) {
        // A malformed legacy row must not abort the whole backfill.
        console.warn(`[backfill] skipping slot ${row.id}:`, (err as Error).message);
        skipped++;
      }
    }

    for (const group of groups.values()) {
      await db(t('court_availability'))
        .whereIn('id', group.ids)
        .update({ starts_at_utc: group.starts, ends_at_utc: group.ends });
      updated += group.ids.length;
    }

    console.log(`[backfill] ${updated} slots converted (through id ${lastId})…`);
  }

  return { updated, skipped };
}

if (require.main === module) {
  backfillSlotInstants()
    .then(({ updated, skipped }) => {
      console.log(`✅ Backfill complete: ${updated} slots converted, ${skipped} skipped.`);
      return db.destroy();
    })
    .then(() => process.exit(0))
    .catch(async (err) => {
      console.error('❌ Backfill failed:', err);
      await db.destroy().catch(() => undefined);
      process.exit(1);
    });
}
