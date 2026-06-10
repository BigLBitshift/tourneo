import { Knex } from 'knex';

const PREFIX = process.env.DB_TABLE_PREFIX || 'tourneo_';
const t = (name: string) => `${PREFIX}${name}`;

/**
 * Migration 016 — booking reminders, Stripe Connect, city-rank pushes
 * and a hot-path index for the availability query.
 *
 *   1. court_bookings.reminder_sent_at — "your court starts in 2h" push
 *      is sent at most once per booking.
 *   2. court_bookings: pending_payment status + stripe_payment_intent_id
 *      for in-app payment via Stripe Connect destination charges.
 *   3. venues: stripe_account_id (connected Express account) and
 *      platform_fee_percent (Tourneo's cut on in-app bookings).
 *   4. profiles: last known padel city rank + last notification time for
 *      the weekly "you dropped to rank N" re-engagement push.
 *   5. court_availability composite index (venue_id, slot_date, status) —
 *      the availability screen always filters on exactly these columns.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable(t('court_bookings'), (table) => {
    table.datetime('reminder_sent_at').nullable();
    table.string('stripe_payment_intent_id', 255).nullable();
    table.index(['stripe_payment_intent_id'], `${t('court_bookings')}_stripe_pi_idx`);
  });

  // Widen the bookings status enum to include pending_payment. MySQL-only
  // syntax; non-MySQL dev databases skip with a warning (the app treats
  // unknown enum support as "pay at venue only").
  try {
    await knex.raw(`
      ALTER TABLE \`${t('court_bookings')}\`
      MODIFY COLUMN status ENUM('pending_payment','confirmed','cancelled') NOT NULL DEFAULT 'confirmed'
    `);
  } catch (err) {
    console.warn('[migration 016] could not widen court_bookings.status enum:', (err as Error).message);
  }

  await knex.schema.alterTable(t('venues'), (table) => {
    table.string('stripe_account_id', 255).nullable();
    table.integer('platform_fee_percent').notNullable().defaultTo(10);
  });

  await knex.schema.alterTable(t('profiles'), (table) => {
    table.integer('city_rank_padel').nullable();
    table.datetime('city_rank_notified_at').nullable();
  });

  await knex.schema.alterTable(t('court_availability'), (table) => {
    table.index(['venue_id', 'slot_date', 'status'], `${t('court_availability')}_lookup_idx`);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable(t('court_availability'), (table) => {
    table.dropIndex(['venue_id', 'slot_date', 'status'], `${t('court_availability')}_lookup_idx`);
  });
  await knex.schema.alterTable(t('profiles'), (table) => {
    table.dropColumn('city_rank_padel');
    table.dropColumn('city_rank_notified_at');
  });
  await knex.schema.alterTable(t('venues'), (table) => {
    table.dropColumn('stripe_account_id');
    table.dropColumn('platform_fee_percent');
  });
  await knex.schema.alterTable(t('court_bookings'), (table) => {
    table.dropIndex(['stripe_payment_intent_id'], `${t('court_bookings')}_stripe_pi_idx`);
    table.dropColumn('reminder_sent_at');
    table.dropColumn('stripe_payment_intent_id');
  });
}
