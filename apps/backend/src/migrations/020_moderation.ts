import type { Knex } from 'knex';

const PREFIX = process.env.DB_TABLE_PREFIX || 'tourneo_';
const t = (name: string) => `${PREFIX}${name}`;

const REPORTS = t('content_reports');
const BLOCKS = t('user_blocks');

/**
 * Migration 020 — Content moderation.
 *
 * The app ships event chat, venue reviews, venue photos, an activity feed
 * and public profiles, with no way to report anything and no way to block
 * anyone. App Store Guideline 1.2 requires all three for user-generated
 * content — a report mechanism, a block mechanism, and the ability to
 * remove content and eject the user who posted it — and the DSA requires a
 * notice-and-action procedure on top.
 *
 * Two tables:
 *   - `content_reports` — one row per report, with a moderation status.
 *     `content_type` + `content_id` rather than a foreign key per surface,
 *     so a new reportable surface needs no schema change.
 *   - `user_blocks` — a personal, one-directional mute. Blocking is
 *     immediate and needs no review, which is exactly why it is the
 *     control that actually protects people; reports take time.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable(REPORTS, (table) => {
    table.bigIncrements('id').primary();
    table
      .bigInteger('reporter_user_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable(t('users'))
      .onDelete('CASCADE');
    table
      .enum('content_type', ['chat_message', 'venue_review', 'venue_photo', 'profile', 'feed_item'])
      .notNullable();
    table.bigInteger('content_id').unsigned().notNullable();
    // Denormalised so a moderator can act on the author even after the
    // content itself has been deleted.
    table
      .bigInteger('reported_user_id')
      .unsigned()
      .nullable()
      .references('id')
      .inTable(t('users'))
      .onDelete('SET NULL');
    table
      .enum('reason', ['spam', 'harassment', 'hate_speech', 'sexual', 'violence', 'other'])
      .notNullable();
    table.string('details', 1000).nullable();
    // A snapshot of what was reported. Without it a moderator reviewing a
    // deleted message has nothing to judge.
    table.text('content_snapshot').nullable();
    table
      .enum('status', ['pending', 'reviewing', 'actioned', 'dismissed'])
      .notNullable()
      .defaultTo('pending');
    table
      .bigInteger('reviewed_by')
      .unsigned()
      .nullable()
      .references('id')
      .inTable(t('users'))
      .onDelete('SET NULL');
    table.string('resolution_note', 1000).nullable();
    table.datetime('reviewed_at').nullable();
    table.datetime('created_at').notNullable();
    table.datetime('updated_at').notNullable();

    table.index(['status', 'created_at'], `${REPORTS}_queue_idx`);
    table.index(['content_type', 'content_id'], `${REPORTS}_content_idx`);
    table.index(['reported_user_id'], `${REPORTS}_reported_idx`);
  });

  // One open report per user per piece of content: re-reporting the same
  // message should not let one person inflate the queue. Resolved reports
  // are NULL here so a repeat offence can be reported again.
  await knex.raw(`
    ALTER TABLE \`${REPORTS}\`
      ADD COLUMN open_reporter_id BIGINT UNSIGNED
        AS (CASE WHEN status IN ('pending','reviewing') THEN reporter_user_id ELSE NULL END) STORED,
      ADD UNIQUE KEY \`${REPORTS}_open_uq\` (content_type, content_id, open_reporter_id)
  `);

  await knex.schema.createTable(BLOCKS, (table) => {
    table.bigIncrements('id').primary();
    table
      .bigInteger('blocker_user_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable(t('users'))
      .onDelete('CASCADE');
    table
      .bigInteger('blocked_user_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable(t('users'))
      .onDelete('CASCADE');
    table.datetime('created_at').notNullable();

    table.unique(['blocker_user_id', 'blocked_user_id'], { indexName: `${BLOCKS}_pair_uq` });
    table.index(['blocked_user_id'], `${BLOCKS}_blocked_idx`);
  });

  // Soft-hide for moderated content, so removing a message from public
  // view does not destroy the evidence the report was filed against.
  const hasHidden = await knex.schema.hasColumn(t('chat_messages'), 'hidden_at');
  if (!hasHidden) {
    await knex.schema.alterTable(t('chat_messages'), (table) => {
      table.datetime('hidden_at').nullable();
      table
        .bigInteger('hidden_by')
        .unsigned()
        .nullable()
        .references('id')
        .inTable(t('users'))
        .onDelete('SET NULL');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn(t('chat_messages'), 'hidden_at')) {
    await knex.schema.alterTable(t('chat_messages'), (table) => {
      table.dropColumn('hidden_by');
      table.dropColumn('hidden_at');
    });
  }
  await knex.schema.dropTableIfExists(BLOCKS);
  await knex.schema.dropTableIfExists(REPORTS);
}
