import * as fs from 'fs';

/**
 * TLS options for the database connection.
 *
 * Lives in its own module so both the runtime pool (`database.ts`) and the
 * migration runner (`knexfile.ts`) share one policy. Importing it from
 * `database.ts` would open a second connection pool as a side effect every
 * time a migration runs.
 *
 * `rejectUnauthorized: false` encrypts the connection but verifies
 * nothing, so anything that can get between the app and the database can
 * present its own certificate and read every query — which is most of what
 * TLS was supposed to prevent. Both call sites used it.
 *
 * Verification is therefore on by default. Set `DB_SSL_CA` to the
 * provider's CA bundle when it uses a private root (IONOS and most managed
 * MariaDB offerings publish one). `DB_SSL_REJECT_UNAUTHORIZED=false`
 * remains available as a deliberate, visible escape hatch for local work —
 * it refuses to apply in production.
 */
export function buildSslOptions(): Record<string, unknown> {
  const caPath = process.env.DB_SSL_CA;
  if (caPath) {
    try {
      return { ca: fs.readFileSync(caPath, 'utf8'), rejectUnauthorized: true };
    } catch (err) {
      // Fail loudly rather than silently downgrading to an unverified
      // connection — a typo in the path must not cost the guarantee.
      throw new Error(
        `DB_SSL_CA is set to "${caPath}" but could not be read: ${(err as Error).message}`
      );
    }
  }

  if (process.env.DB_SSL_REJECT_UNAUTHORIZED === 'false') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'DB_SSL_REJECT_UNAUTHORIZED=false is not permitted in production. ' +
          "Point DB_SSL_CA at your provider's CA bundle instead."
      );
    }
    console.warn('⚠️  Database TLS certificate verification is DISABLED (development only)');
    return { rejectUnauthorized: false };
  }

  return { rejectUnauthorized: true };
}
