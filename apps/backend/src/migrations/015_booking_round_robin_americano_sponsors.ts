import { Knex } from 'knex';

const PREFIX = process.env.DB_TABLE_PREFIX || 'tourneo_';
const t = (name: string) => `${PREFIX}${name}`;

/**
 * Migration 015 — Market-expansion features.
 *
 *   1. court_bookings — in-app court booking on top of the existing
 *      court_availability slots (previously slots could only link out to
 *      external booking URLs).
 *   2. Sponsor fields on events — sponsor name/logo/link shown on the
 *      event page, bracket and shared match cards.
 *   3. Americano sessions/rounds/matches — the rotating-partner format.
 *      Americano pairs change every round, so its matches don't fit the
 *      registration-based `matches` table and get their own structure
 *      with individual player references.
 *
 * Round-robin needs no new tables: it reuses `brackets` + `matches`
 * (structure JSON discriminates the type, matches simply have no
 * next_match_id).
 */
export async function up(knex: Knex): Promise<void> {
  // 1. Court bookings
  await knex.schema.createTable(t('court_bookings'), (table) => {
    table.bigIncrements('id').primary();
    table.string('uuid', 36).notNullable().unique();
    table.bigInteger('slot_id').unsigned().notNullable()
      .references('id').inTable(t('court_availability')).onDelete('CASCADE');
    table.bigInteger('venue_id').unsigned().notNullable()
      .references('id').inTable(t('venues'));
    table.bigInteger('court_id').unsigned().nullable()
      .references('id').inTable(t('courts'));
    table.bigInteger('user_id').unsigned().notNullable()
      .references('id').inTable(t('users'));
    table.enum('status', ['confirmed', 'cancelled']).defaultTo('confirmed');
    table.integer('price_cents').nullable();
    table.string('currency', 3).defaultTo('EUR');
    // v1 bookings are reservations paid at the venue; the column keeps the
    // door open for in-app Stripe payment without a schema change.
    table.enum('payment_method', ['pay_at_venue', 'card', 'membership', 'other'])
      .defaultTo('pay_at_venue');
    table.string('notes', 500).nullable();
    table.datetime('booked_at').notNullable();
    table.datetime('cancelled_at').nullable();
    table.datetime('created_at').notNullable();
    table.datetime('updated_at').notNullable();
    table.index(['user_id', 'status']);
    table.index(['venue_id', 'status']);
    table.index(['slot_id']);
  });

  // 2. Sponsor fields on events
  await knex.schema.alterTable(t('events'), (table) => {
    table.string('sponsor_name', 100).nullable();
    table.string('sponsor_logo_url', 500).nullable();
    table.string('sponsor_website_url', 500).nullable();
  });

  // 3. Americano
  await knex.schema.createTable(t('americano_sessions'), (table) => {
    table.bigIncrements('id').primary();
    table.bigInteger('event_id').unsigned().notNullable().unique()
      .references('id').inTable(t('events')).onDelete('CASCADE');
    table.integer('courts_count').notNullable().defaultTo(1);
    table.integer('points_per_match').notNullable().defaultTo(16);
    table.integer('rounds_count').notNullable();
    table.enum('status', ['draft', 'in_progress', 'completed']).defaultTo('draft');
    table.bigInteger('created_by').unsigned().notNullable()
      .references('id').inTable(t('users'));
    table.datetime('created_at').notNullable();
    table.datetime('updated_at').notNullable();
  });

  await knex.schema.createTable(t('americano_matches'), (table) => {
    table.bigIncrements('id').primary();
    table.bigInteger('session_id').unsigned().notNullable()
      .references('id').inTable(t('americano_sessions')).onDelete('CASCADE');
    table.integer('round_number').notNullable();
    table.integer('court_number').notNullable().defaultTo(1);
    table.bigInteger('team_a_player_1').unsigned().notNullable().references('id').inTable(t('users'));
    table.bigInteger('team_a_player_2').unsigned().nullable().references('id').inTable(t('users'));
    table.bigInteger('team_b_player_1').unsigned().notNullable().references('id').inTable(t('users'));
    table.bigInteger('team_b_player_2').unsigned().nullable().references('id').inTable(t('users'));
    table.integer('score_a').nullable();
    table.integer('score_b').nullable();
    table.enum('status', ['upcoming', 'completed']).defaultTo('upcoming');
    table.datetime('completed_at').nullable();
    table.datetime('created_at').notNullable();
    table.datetime('updated_at').notNullable();
    table.index(['session_id', 'round_number']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(t('americano_matches'));
  await knex.schema.dropTableIfExists(t('americano_sessions'));
  await knex.schema.alterTable(t('events'), (table) => {
    table.dropColumn('sponsor_name');
    table.dropColumn('sponsor_logo_url');
    table.dropColumn('sponsor_website_url');
  });
  await knex.schema.dropTableIfExists(t('court_bookings'));
}
