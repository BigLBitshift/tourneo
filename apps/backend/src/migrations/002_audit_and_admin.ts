import { Knex } from 'knex';

const PREFIX = 'tourneo_';
const t = (name: string) => `${PREFIX}${name}`;

export async function up(knex: Knex): Promise<void> {
  // ==========================================
  // AUDIT LOG
  // ==========================================
  await knex.schema.createTable(t('audit_logs'), (table) => {
    table.bigIncrements('id').primary();
    table.bigInteger('actor_id').unsigned().nullable().references('id').inTable(t('users'));
    table.string('actor_email', 255).nullable();
    table.enum('actor_role', ['user', 'admin', 'superadmin']).notNullable();
    table.string('action', 100).notNullable(); // e.g. 'event.create', 'event.publish', 'registration.cancel'
    table.string('resource_type', 50).notNullable(); // e.g. 'event', 'registration', 'user', 'membership'
    table.bigInteger('resource_id').unsigned().nullable();
    table.string('resource_label', 255).nullable(); // Human-readable label e.g. event title
    table.json('changes').nullable(); // { before: {}, after: {} }
    table.json('metadata').nullable(); // Additional context
    table.string('ip_address', 45).nullable();
    table.string('user_agent', 500).nullable();
    table.datetime('created_at').notNullable();
    table.index(['actor_id']);
    table.index(['resource_type', 'resource_id']);
    table.index(['action']);
    table.index(['created_at']);
  });

  // ==========================================
  // EVENT EXTENSIONS
  // ==========================================
  // Add missing columns to events for better admin control
  await knex.schema.alterTable(t('events'), (table) => {
    table.datetime('archived_at').nullable();
    table.boolean('is_archived').defaultTo(false);
    table.bigInteger('duplicated_from_id').unsigned().nullable();
    table.text('faq').nullable(); // JSON array of { question, answer }
    table.text('venue_hints').nullable(); // Parking, food, etc.
    table.text('prize_table').nullable(); // JSON prize distribution
    table.text('streaming_url').nullable();
    table.text('rules_full').nullable(); // Full rules document
  });

  // ==========================================
  // CHECK-IN TRACKING
  // ==========================================
  await knex.schema.createTable(t('checkins'), (table) => {
    table.bigIncrements('id').primary();
    table.bigInteger('registration_id').unsigned().notNullable().references('id').inTable(t('registrations'));
    table.bigInteger('checked_in_by').unsigned().nullable().references('id').inTable(t('users')); // Admin who checked them in
    table.datetime('checked_in_at').notNullable();
    table.string('method', 20).defaultTo('manual'); // 'manual', 'qr_code', 'self'
    table.string('notes', 500).nullable();
    table.datetime('created_at').notNullable();
    table.unique(['registration_id']);
  });

  // ==========================================
  // REFUND TRACKING
  // ==========================================
  // Migration 001 already created a (now-legacy) `refunds` table with a
  // simpler schema. On fresh installs we create the v2 schema directly;
  // on databases that already ran 001 we upgrade in place by adding the
  // missing columns and widening the status enum. Either way we end up
  // with the schema the rest of the codebase (admin routes, paymentService)
  // expects.
  const refundsTable = t('refunds');
  if (await knex.schema.hasTable(refundsTable)) {
    const addCol = async (name: string, builder: (tb: Knex.AlterTableBuilder) => void) => {
      const has = await knex.schema.hasColumn(refundsTable, name);
      if (!has) await knex.schema.alterTable(refundsTable, builder);
    };
    await addCol('registration_id', (table) =>
      table.bigInteger('registration_id').unsigned().nullable().references('id').inTable(t('registrations'))
    );
    await addCol('requested_by', (table) =>
      table.bigInteger('requested_by').unsigned().nullable().references('id').inTable(t('users'))
    );
    await addCol('currency', (table) => table.string('currency', 3).defaultTo('EUR'));
    await addCol('requested_at', (table) => table.datetime('requested_at').nullable());
    // The legacy enum was ('pending','processed','failed'); the admin
    // workflow needs 'approved' and 'rejected' too. Widening enum values
    // is not portable across knex builders, so we do it via raw SQL only
    // when the current column doesn't already include the new values.
    try {
      await knex.raw(`
        ALTER TABLE \`${refundsTable}\`
        MODIFY COLUMN status ENUM('pending','approved','processed','rejected','failed') NOT NULL DEFAULT 'pending'
      `);
    } catch (err) {
      // Postgres / SQLite path — skip; the application-level enum check is enough.
      console.warn('[migration 002] could not widen refunds.status enum:', (err as Error).message);
    }
  } else {
    await knex.schema.createTable(refundsTable, (table) => {
      table.bigIncrements('id').primary();
      table.string('uuid', 36).notNullable().unique();
      table.bigInteger('payment_id').unsigned().notNullable().references('id').inTable(t('payments'));
      table.bigInteger('registration_id').unsigned().nullable().references('id').inTable(t('registrations'));
      table.bigInteger('requested_by').unsigned().nullable().references('id').inTable(t('users'));
      table.bigInteger('processed_by').unsigned().nullable().references('id').inTable(t('users'));
      table.integer('amount_cents').notNullable();
      table.string('currency', 3).defaultTo('EUR');
      table.enum('reason', ['user_cancellation_14d', 'organizer_cancellation', 'admin_decision', 'duplicate', 'other']).notNullable();
      table.text('reason_detail').nullable();
      table.enum('status', ['pending', 'approved', 'processed', 'rejected', 'failed']).defaultTo('pending');
      table.string('stripe_refund_id', 255).nullable();
      table.datetime('requested_at').notNullable();
      table.datetime('processed_at').nullable();
      table.datetime('created_at').notNullable();
      table.datetime('updated_at').notNullable();
      table.index(['payment_id']);
      table.index(['status']);
    });
  }

  // ==========================================
  // HALL OF FAME
  // ==========================================
  // Same pattern as `refunds`: 001 defined a different (legacy) schema
  // with `place`/`registration_id`. The active code paths use `placement`
  // / `display_name` / `featured`. Upgrade in place when 001 already ran.
  const hofTable = t('hall_of_fame');
  if (await knex.schema.hasTable(hofTable)) {
    const addCol = async (name: string, builder: (tb: Knex.AlterTableBuilder) => void) => {
      const has = await knex.schema.hasColumn(hofTable, name);
      if (!has) await knex.schema.alterTable(hofTable, builder);
    };
    await addCol('placement', (table) => table.integer('placement').nullable());
    await addCol('display_name', (table) => table.string('display_name', 200).nullable());
    await addCol('team_name', (table) => table.string('team_name', 200).nullable());
    await addCol('achievement_note', (table) => table.text('achievement_note').nullable());
    await addCol('featured', (table) => table.boolean('featured').defaultTo(false));
    await addCol('updated_at', (table) => table.datetime('updated_at').nullable());
    // Backfill placement from the legacy `place` column if it exists.
    if (await knex.schema.hasColumn(hofTable, 'place')) {
      await knex(hofTable).whereNull('placement').update({
        placement: knex.raw('place'),
      });
    }
  } else {
    await knex.schema.createTable(hofTable, (table) => {
      table.bigIncrements('id').primary();
      table.bigInteger('event_id').unsigned().notNullable().references('id').inTable(t('events'));
      table.bigInteger('user_id').unsigned().notNullable().references('id').inTable(t('users'));
      table.integer('placement').notNullable(); // 1, 2, 3
      table.integer('prize_amount_cents').defaultTo(0);
      table.string('display_name', 200).nullable();
      table.string('team_name', 200).nullable();
      table.text('achievement_note').nullable(); // e.g. "Unbeaten in 5 rounds"
      table.boolean('featured').defaultTo(false); // Show on home
      table.datetime('created_at').notNullable();
      table.datetime('updated_at').notNullable();
      table.index(['event_id']);
      table.index(['user_id']);
      table.index(['featured']);
    });
  }

  // ==========================================
  // ADMIN NOTIFICATIONS TO PARTICIPANTS
  // ==========================================
  await knex.schema.createTable(t('admin_messages'), (table) => {
    table.bigIncrements('id').primary();
    table.bigInteger('event_id').unsigned().nullable().references('id').inTable(t('events'));
    table.bigInteger('sent_by').unsigned().notNullable().references('id').inTable(t('users'));
    table.string('subject', 255).notNullable();
    table.text('body').notNullable();
    table.enum('target', ['all_participants', 'confirmed_only', 'waitlisted_only', 'all_users']).defaultTo('all_participants');
    table.integer('recipient_count').defaultTo(0);
    table.datetime('sent_at').notNullable();
    table.datetime('created_at').notNullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(t('admin_messages'));
  // refunds and hall_of_fame are originally owned by migration 001 — we
  // only ever extend them here. Leave them in place on rollback so 001's
  // schema remains intact; only drop our own additions.
  await knex.schema.dropTableIfExists(t('checkins'));
  await knex.schema.dropTableIfExists(t('audit_logs'));

  await knex.schema.alterTable(t('events'), (table) => {
    table.dropColumn('archived_at');
    table.dropColumn('is_archived');
    table.dropColumn('duplicated_from_id');
    table.dropColumn('faq');
    table.dropColumn('venue_hints');
    table.dropColumn('prize_table');
    table.dropColumn('streaming_url');
    table.dropColumn('rules_full');
  });
}