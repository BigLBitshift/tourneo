import type { Knex } from 'knex';

const PREFIX = process.env.DB_TABLE_PREFIX || 'tourneo_';
const t = (name: string) => `${PREFIX}${name}`;

const AVAIL = t('court_availability');
const WAITLIST = t('slot_waitlist');
const OFFERS = t('slot_offers');
const PREFS = t('notification_prefs');

/**
 * Migration 019 — The live court queue.
 *
 * When a court frees up — a cancellation, a failed payment, an expired
 * unpaid booking, a club blocking a slot — the first person in that
 * slot's queue is offered it and the slot is held for them for a few
 * minutes. If they don't claim it, the offer expires and the next person
 * gets the same window.
 *
 * Ordering is tier-first (Club > Plus > Free), then FIFO, matching the
 * tournament waitlist in `registrationService.ts`. The joining member's
 * tier is denormalised onto the row so a membership that lapses overnight
 * cannot silently reshuffle a queue whose positions people are watching.
 */
export async function up(knex: Knex): Promise<void> {
  // A user's place in the queue for one specific slot.
  await knex.schema.createTable(WAITLIST, (table) => {
    table.bigIncrements('id').primary();
    table
      .bigInteger('slot_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable(AVAIL)
      .onDelete('CASCADE');
    table
      .bigInteger('user_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable(t('users'))
      .onDelete('CASCADE');
    // Denormalised so "my queue" and the club-facing demand report never
    // need a three-table join.
    table
      .bigInteger('venue_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable(t('venues'))
      .onDelete('CASCADE');
    table.datetime('slot_starts_at_utc').notNullable();
    table.integer('position').notNullable();
    table
      .enum('membership_tier_at_join', ['free', 'plus', 'club'])
      .notNullable()
      .defaultTo('free');
    table
      .enum('status', [
        'queued',
        'offered',
        'claimed',
        'declined',
        'expired',
        'cancelled',
        'superseded',
      ])
      .notNullable()
      .defaultTo('queued');
    // Club perk: claim automatically instead of racing a countdown.
    table.boolean('auto_claim').notNullable().defaultTo(false);
    table.datetime('joined_at').notNullable();
    table.datetime('left_at').nullable();
    table.datetime('created_at').notNullable();
    table.datetime('updated_at').notNullable();

    table.index(['slot_id', 'status'], `${WAITLIST}_slot_status_idx`);
    table.index(['user_id', 'status'], `${WAITLIST}_user_status_idx`);
    table.index(['venue_id', 'slot_starts_at_utc'], `${WAITLIST}_venue_demand_idx`);
  });

  // One active entry per user per slot. Historical rows (declined,
  // expired, cancelled) must not block a re-join, so the key is built on
  // a generated column that is NULL for anything inactive — MySQL treats
  // NULLs as distinct in a UNIQUE index, which is exactly what we want here.
  await knex.raw(`
    ALTER TABLE \`${WAITLIST}\`
      ADD COLUMN active_user_id BIGINT UNSIGNED
        AS (CASE WHEN status IN ('queued','offered') THEN user_id ELSE NULL END) STORED,
      ADD UNIQUE KEY \`${WAITLIST}_active_uq\` (slot_id, active_user_id)
  `);

  // A time-boxed right to claim one slot.
  await knex.schema.createTable(OFFERS, (table) => {
    table.bigIncrements('id').primary();
    table
      .bigInteger('slot_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable(AVAIL)
      .onDelete('CASCADE');
    table
      .bigInteger('waitlist_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable(WAITLIST)
      .onDelete('CASCADE');
    table
      .bigInteger('user_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable(t('users'))
      .onDelete('CASCADE');
    table
      .enum('status', ['pending', 'claimed', 'declined', 'expired', 'cancelled'])
      .notNullable()
      .defaultTo('pending');
    table.datetime('expires_at').notNullable();
    table.datetime('responded_at').nullable();
    // How many people this slot has already been offered to, so a slot
    // cascading through a long queue can be capped rather than spamming
    // fifty players in ten minutes.
    table.integer('offer_index').notNullable().defaultTo(0);
    table.datetime('created_at').notNullable();
    table.datetime('updated_at').notNullable();

    table.index(['status', 'expires_at'], `${OFFERS}_expiry_idx`);
    table.index(['user_id', 'status'], `${OFFERS}_user_idx`);
    table.index(['slot_id'], `${OFFERS}_slot_idx`);
  });

  // Only one pending offer may exist per slot at a time — the invariant
  // that makes "held for exactly one person" true at the schema level.
  await knex.raw(`
    ALTER TABLE \`${OFFERS}\`
      ADD COLUMN pending_slot_id BIGINT UNSIGNED
        AS (CASE WHEN status = 'pending' THEN slot_id ELSE NULL END) STORED,
      ADD UNIQUE KEY \`${OFFERS}_pending_uq\` (pending_slot_id)
  `);

  // court_availability.hold_offer_id was added in 018 without its FK
  // because this table did not exist yet.
  await knex.schema.alterTable(AVAIL, (table) => {
    table.foreign('hold_offer_id').references('id').inTable(OFFERS).onDelete('SET NULL');
  });

  // Per-user delivery preferences. A busy Saturday evening at one club
  // must never produce forty pushes; that is how a flagship feature
  // becomes an uninstall.
  await knex.schema.createTable(PREFS, (table) => {
    table.bigIncrements('id').primary();
    table
      .bigInteger('user_id')
      .unsigned()
      .notNullable()
      .unique()
      .references('id')
      .inTable(t('users'))
      .onDelete('CASCADE');
    table.string('timezone', 64).notNullable().defaultTo('Europe/Berlin');
    // Local wall-clock quiet hours; may wrap past midnight.
    table.time('quiet_hours_start').nullable().defaultTo('22:00:00');
    table.time('quiet_hours_end').nullable().defaultTo('08:00:00');
    table.boolean('slot_alerts_enabled').notNullable().defaultTo(true);
    // An offer is time-critical and expires; suppressing it entirely would
    // silently cost the user the court, so quiet hours only mute the push
    // by default rather than withholding the offer.
    table.boolean('pause_offers_during_quiet_hours').notNullable().defaultTo(false);
    table.integer('max_slot_alerts_per_day').notNullable().defaultTo(5);
    table.datetime('created_at').notNullable();
    table.datetime('updated_at').notNullable();
  });

  // Dedupe key for push delivery, so a retried job cannot double-send.
  const hasDedupe = await knex.schema.hasColumn(t('notifications'), 'dedupe_key');
  if (!hasDedupe) {
    await knex.schema.alterTable(t('notifications'), (table) => {
      table.string('dedupe_key', 191).nullable();
      table.unique(['dedupe_key'], { indexName: `${t('notifications')}_dedupe_uq` });
    });
  }

  // The notification type enum predates court queues.
  await knex.raw(`
    ALTER TABLE \`${t('notifications')}\`
    MODIFY COLUMN type ENUM(
      'registration_confirmed', 'event_published', 'waitlist_promoted',
      'event_reminder_1d', 'event_reminder_1h', 'checkin_available',
      'match_upcoming', 'result_entered', 'tournament_completed',
      'prize_available', 'membership_renewed', 'general',
      'slot_offer', 'slot_offer_expiring', 'slot_freed'
    )
  `);
}

export async function down(knex: Knex): Promise<void> {
  // Narrow the enum only after nothing is left that would fall outside it.
  await knex(t('notifications'))
    .whereIn('type', ['slot_offer', 'slot_offer_expiring', 'slot_freed'])
    .update({ type: 'general' });
  await knex.raw(`
    ALTER TABLE \`${t('notifications')}\`
    MODIFY COLUMN type ENUM(
      'registration_confirmed', 'event_published', 'waitlist_promoted',
      'event_reminder_1d', 'event_reminder_1h', 'checkin_available',
      'match_upcoming', 'result_entered', 'tournament_completed',
      'prize_available', 'membership_renewed', 'general'
    )
  `);

  if (await knex.schema.hasColumn(t('notifications'), 'dedupe_key')) {
    await knex.schema.alterTable(t('notifications'), (table) => {
      table.dropUnique(['dedupe_key'], `${t('notifications')}_dedupe_uq`);
      table.dropColumn('dedupe_key');
    });
  }

  await knex.schema.dropTableIfExists(PREFS);

  // Drop the FK before the table it points at.
  await knex.schema.alterTable(AVAIL, (table) => {
    table.dropForeign('hold_offer_id');
  });

  await knex.schema.dropTableIfExists(OFFERS);
  await knex.schema.dropTableIfExists(WAITLIST);
}
