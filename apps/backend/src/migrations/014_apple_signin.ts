import { Knex } from 'knex';

const PREFIX = process.env.DB_TABLE_PREFIX || 'tourneo_';
const t = (name: string) => `${PREFIX}${name}`;

/**
 * Migration 014 — Apple Sign-In support.
 *
 * Apple users authenticate without a password and Apple does not provide
 * a date of birth, so:
 *   - profiles.date_of_birth becomes nullable (email registration still
 *     enforces it through the Zod registerSchema, so nothing changes for
 *     the classic flow)
 *   - users.auth_provider records how the account was created so the
 *     login endpoint can give a helpful error when an Apple user tries
 *     to log in with a password.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable(t('profiles'), (table) => {
    table.date('date_of_birth').nullable().alter();
  });

  const hasProvider = await knex.schema.hasColumn(t('users'), 'auth_provider');
  if (!hasProvider) {
    await knex.schema.alterTable(t('users'), (table) => {
      table.enum('auth_provider', ['email', 'apple']).defaultTo('email');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  const hasProvider = await knex.schema.hasColumn(t('users'), 'auth_provider');
  if (hasProvider) {
    await knex.schema.alterTable(t('users'), (table) => {
      table.dropColumn('auth_provider');
    });
  }
  // date_of_birth stays nullable on rollback — restoring NOT NULL would
  // fail if Apple users without a DOB already exist.
}
