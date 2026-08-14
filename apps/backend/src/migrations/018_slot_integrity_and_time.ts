import type { Knex } from 'knex';

const PREFIX = process.env.DB_TABLE_PREFIX || 'tourneo_';
const t = (name: string) => `${PREFIX}${name}`;

const AVAIL = t('court_availability');
const SLOT_UQ = `${AVAIL}_slot_uq`;

/**
 * Migration 018 — Foundations for the live court queue.
 *
 * A queue built on top of duplicated slot rows means two independent
 * queues for one physical court: two holds, two bookings, one very angry
 * club. And a claim countdown derived from a naive `slot_date`/`slot_start`
 * pair is two hours wrong in CEST, because the DB connection is pinned to
 * UTC (`config/database.ts`). Both problems must be gone before any queue
 * can be trusted, so they ship separately from the feature itself.
 *
 * What this migration does:
 *   1. `venues.timezone` — no code anywhere declared Europe/Berlin before.
 *   2. Absolute instants (`starts_at_utc`/`ends_at_utc`) on every slot,
 *      plus provenance (`source`, `confidence`) so the UI can tell the
 *      truth about slots we merely assume are free.
 *   3. Deduplicates existing slots, then adds the unique key that makes
 *      re-running slot generation idempotent.
 *   4. Adds the `held` status and the hold columns the claim window needs.
 *
 * `starts_at_utc` is backfilled by `scripts/backfillSlotInstants.ts`, not
 * here: `CONVERT_TZ(…, 'Europe/Berlin', '+00:00')` silently returns NULL
 * unless the server's timezone tables were loaded with
 * `mysql_tzinfo_to_sql`, which is a classic silent production failure.
 * Node computes the offset correctly with zero server-side prerequisites.
 */
export async function up(knex: Knex): Promise<void> {
  // 1. Venue timezone.
  const hasTimezone = await knex.schema.hasColumn(t('venues'), 'timezone');
  if (!hasTimezone) {
    await knex.schema.alterTable(t('venues'), (table) => {
      table.string('timezone', 64).notNullable().defaultTo('Europe/Berlin');
    });
  }

  // 2. Absolute instants, provenance and an optimistic-concurrency counter.
  await knex.schema.alterTable(AVAIL, (table) => {
    table.datetime('starts_at_utc').nullable();
    table.datetime('ends_at_utc').nullable();
    table
      .enum('source', ['venue', 'import', 'assumed', 'crowd', 'admin'])
      .notNullable()
      .defaultTo('admin');
    table.tinyint('confidence').notNullable().defaultTo(100);
    table.enum('sport', ['padel', 'tennis', 'multi']).notNullable().defaultTo('padel');
    table.integer('version').unsigned().notNullable().defaultTo(0);
    table.index(['starts_at_utc', 'status'], `${AVAIL}_instant_idx`);
  });

  // 3. Dedupe before the unique key can be added.
  //
  // The NOT EXISTS guard is load-bearing: court_bookings.slot_id is
  // ON DELETE CASCADE (migration 015), so deleting a duplicated slot that
  // carries a live booking would silently destroy that booking.
  await knex.raw(`
    DELETE ca FROM \`${AVAIL}\` ca
    JOIN (
      SELECT MIN(id) AS keep_id, venue_id, COALESCE(court_id, 0) AS ck, slot_date, slot_start
      FROM \`${AVAIL}\`
      GROUP BY venue_id, ck, slot_date, slot_start
      HAVING COUNT(*) > 1
    ) d
      ON d.venue_id = ca.venue_id
     AND COALESCE(ca.court_id, 0) = d.ck
     AND ca.slot_date = d.slot_date
     AND ca.slot_start = d.slot_start
    WHERE ca.id <> d.keep_id
      AND NOT EXISTS (
        SELECT 1 FROM \`${t('court_bookings')}\` b
        WHERE b.slot_id = ca.id AND b.status <> 'cancelled'
      )
  `);

  // MySQL/MariaDB treat NULLs as distinct in a UNIQUE index, and court_id
  // is nullable — `generateRecurring` writes NULL by default for
  // venue-level slots. A plain UNIQUE would therefore not protect exactly
  // the rows most likely to be duplicated. A STORED generated column
  // collapses NULL to 0 so the constraint actually bites.
  const uqExists = await indexExists(knex, AVAIL, SLOT_UQ);
  if (!uqExists) {
    await knex.raw(`
      ALTER TABLE \`${AVAIL}\`
        ADD COLUMN court_key BIGINT UNSIGNED AS (COALESCE(court_id, 0)) STORED,
        ADD UNIQUE KEY \`${SLOT_UQ}\` (venue_id, court_key, slot_date, slot_start)
    `);
  }

  // 4. The hold state that makes a claim window possible.
  await knex.raw(`
    ALTER TABLE \`${AVAIL}\`
    MODIFY COLUMN status ENUM('available', 'held', 'booked', 'blocked')
      NOT NULL DEFAULT 'available'
  `);

  await knex.schema.alterTable(AVAIL, (table) => {
    table
      .bigInteger('held_for_user_id')
      .unsigned()
      .nullable()
      .references('id')
      .inTable(t('users'))
      .onDelete('SET NULL');
    // FK deliberately deferred to 019, where slot_offers is created.
    table.bigInteger('hold_offer_id').unsigned().nullable();
    table.datetime('hold_expires_at').nullable();
    table.index(['status', 'hold_expires_at'], `${AVAIL}_hold_idx`);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable(AVAIL, (table) => {
    table.dropIndex(['status', 'hold_expires_at'], `${AVAIL}_hold_idx`);
    table.dropColumn('hold_expires_at');
    table.dropColumn('hold_offer_id');
    table.dropColumn('held_for_user_id');
  });

  // Any surviving 'held' row has to land somewhere valid before the enum
  // narrows again, otherwise MariaDB coerces it to an empty string.
  await knex(AVAIL).where('status', 'held').update({ status: 'available' });
  await knex.raw(`
    ALTER TABLE \`${AVAIL}\`
    MODIFY COLUMN status ENUM('available', 'booked', 'blocked')
      NOT NULL DEFAULT 'available'
  `);

  if (await indexExists(knex, AVAIL, SLOT_UQ)) {
    await knex.raw(`ALTER TABLE \`${AVAIL}\` DROP INDEX \`${SLOT_UQ}\`, DROP COLUMN court_key`);
  }

  await knex.schema.alterTable(AVAIL, (table) => {
    table.dropIndex(['starts_at_utc', 'status'], `${AVAIL}_instant_idx`);
    table.dropColumn('version');
    table.dropColumn('sport');
    table.dropColumn('confidence');
    table.dropColumn('source');
    table.dropColumn('ends_at_utc');
    table.dropColumn('starts_at_utc');
  });

  if (await knex.schema.hasColumn(t('venues'), 'timezone')) {
    await knex.schema.alterTable(t('venues'), (table) => {
      table.dropColumn('timezone');
    });
  }
}

async function indexExists(knex: Knex, table: string, indexName: string): Promise<boolean> {
  const res: any = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
    [table, indexName]
  );
  return Number(res?.[0]?.[0]?.cnt || 0) > 0;
}
