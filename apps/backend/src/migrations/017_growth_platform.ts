import { Knex } from 'knex';

const PREFIX = process.env.DB_TABLE_PREFIX || 'tourneo_';
const t = (name: string) => `${PREFIX}${name}`;

/**
 * Migration 017 — growth platform: Spiel-jetzt matchmaking, seasons,
 * streaks, promo codes, private events, dynamic slot pricing.
 */
export async function up(knex: Knex): Promise<void> {
  // ── Spiel jetzt / direct challenges ─────────────────────
  await knex.schema.createTable(t('match_requests'), (table) => {
    table.bigIncrements('id').primary();
    table.string('uuid', 36).notNullable().unique();
    table.bigInteger('requester_id').unsigned().notNullable().references('id').inTable(t('users'));
    table.enum('request_type', ['open', 'direct']).notNullable().defaultTo('open');
    table.enum('sport', ['padel', 'fifa']).notNullable().defaultTo('padel');
    table.string('city', 100).nullable();
    table.integer('players_needed').notNullable().defaultTo(3);
    table.bigInteger('slot_id').unsigned().nullable().references('id').inTable(t('court_availability'));
    table.bigInteger('booking_id').unsigned().nullable().references('id').inTable(t('court_bookings'));
    table.enum('status', ['searching', 'matched', 'booked', 'cancelled', 'expired']).defaultTo('searching');
    table.datetime('expires_at').notNullable();
    table.datetime('created_at').notNullable();
    table.datetime('updated_at').notNullable();
    table.index(['status', 'expires_at']);
    table.index(['requester_id']);
  });

  await knex.schema.createTable(t('match_request_invites'), (table) => {
    table.bigIncrements('id').primary();
    table.bigInteger('request_id').unsigned().notNullable()
      .references('id').inTable(t('match_requests')).onDelete('CASCADE');
    table.bigInteger('user_id').unsigned().notNullable().references('id').inTable(t('users'));
    table.enum('status', ['invited', 'accepted', 'declined']).defaultTo('invited');
    table.datetime('responded_at').nullable();
    table.datetime('created_at').notNullable();
    table.unique(['request_id', 'user_id']);
    table.index(['user_id', 'status']);
  });

  // ── Seasons ─────────────────────────────────────────────
  await knex.schema.createTable(t('seasons'), (table) => {
    table.bigIncrements('id').primary();
    table.string('code', 20).notNullable().unique(); // e.g. 2026-Q2
    table.datetime('starts_at').notNullable();
    table.datetime('ends_at').notNullable();
    table.enum('status', ['active', 'completed']).defaultTo('active');
    table.datetime('created_at').notNullable();
  });

  await knex.schema.createTable(t('season_results'), (table) => {
    table.bigIncrements('id').primary();
    table.bigInteger('season_id').unsigned().notNullable()
      .references('id').inTable(t('seasons')).onDelete('CASCADE');
    table.bigInteger('user_id').unsigned().notNullable().references('id').inTable(t('users'));
    table.enum('sport', ['padel', 'fifa']).notNullable();
    table.integer('final_elo').notNullable();
    table.integer('final_rank').notNullable();
    table.string('city', 100).nullable();
    table.datetime('created_at').notNullable();
    table.unique(['season_id', 'user_id', 'sport']);
    table.index(['user_id']);
  });

  // ── Streaks ─────────────────────────────────────────────
  await knex.schema.alterTable(t('profiles'), (table) => {
    table.integer('week_streak').notNullable().defaultTo(0);
    table.integer('longest_week_streak').notNullable().defaultTo(0);
    table.string('last_played_week', 8).nullable(); // ISO year-week "2026-W23"
    table.datetime('streak_warned_at').nullable();
  });

  // ── Promo codes ─────────────────────────────────────────
  await knex.schema.createTable(t('promo_codes'), (table) => {
    table.bigIncrements('id').primary();
    table.string('code', 32).notNullable().unique();
    table.integer('percent_off').nullable(); // 1-100
    table.integer('amount_off_cents').nullable();
    table.integer('max_redemptions').nullable();
    table.integer('redemption_count').notNullable().defaultTo(0);
    table.datetime('expires_at').nullable();
    table.boolean('is_active').notNullable().defaultTo(true);
    table.datetime('created_at').notNullable();
  });

  await knex.schema.createTable(t('promo_redemptions'), (table) => {
    table.bigIncrements('id').primary();
    table.bigInteger('promo_code_id').unsigned().notNullable()
      .references('id').inTable(t('promo_codes'));
    table.bigInteger('user_id').unsigned().notNullable().references('id').inTable(t('users'));
    table.bigInteger('payment_id').unsigned().nullable().references('id').inTable(t('payments'));
    table.datetime('created_at').notNullable();
    table.unique(['promo_code_id', 'user_id']);
  });

  // ── Private events ──────────────────────────────────────
  await knex.schema.alterTable(t('events'), (table) => {
    table.string('invite_token', 36).nullable().unique();
  });
  try {
    await knex.raw(`
      ALTER TABLE \`${t('events')}\`
      MODIFY COLUMN access_type ENUM('public','members_only','club_only','private') NOT NULL DEFAULT 'public'
    `);
  } catch (err) {
    console.warn('[migration 017] could not widen events.access_type enum:', (err as Error).message);
  }

  // ── Dynamic slot pricing ────────────────────────────────
  await knex.schema.createTable(t('pricing_rules'), (table) => {
    table.bigIncrements('id').primary();
    table.bigInteger('venue_id').unsigned().notNullable()
      .references('id').inTable(t('venues')).onDelete('CASCADE');
    // Bitmask Mon=1 … Sun=64; 127 = every day
    table.integer('weekday_mask').notNullable().defaultTo(127);
    table.time('start_time').notNullable();
    table.time('end_time').notNullable();
    table.integer('price_cents').notNullable();
    table.boolean('is_active').notNullable().defaultTo(true);
    table.datetime('created_at').notNullable();
    table.index(['venue_id', 'is_active']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(t('pricing_rules'));
  await knex.schema.alterTable(t('events'), (table) => {
    table.dropColumn('invite_token');
  });
  await knex.schema.dropTableIfExists(t('promo_redemptions'));
  await knex.schema.dropTableIfExists(t('promo_codes'));
  await knex.schema.alterTable(t('profiles'), (table) => {
    table.dropColumn('week_streak');
    table.dropColumn('longest_week_streak');
    table.dropColumn('last_played_week');
    table.dropColumn('streak_warned_at');
  });
  await knex.schema.dropTableIfExists(t('season_results'));
  await knex.schema.dropTableIfExists(t('seasons'));
  await knex.schema.dropTableIfExists(t('match_request_invites'));
  await knex.schema.dropTableIfExists(t('match_requests'));
}
