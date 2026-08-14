import { env } from './environment';
import { buildSslOptions } from './dbSsl';
import type { Knex } from 'knex';

const config: { [key: string]: Knex.Config } = {
  development: {
    client: 'mysql2',
    connection: {
      host: env.db.host,
      port: env.db.port,
      database: env.db.name,
      user: env.db.user,
      password: env.db.password,
      charset: 'utf8mb4',
      timezone: '+00:00',
    },
    pool: {
      min: env.db.poolMin,
      max: env.db.poolMax,
    },
    migrations: {
      directory: '../migrations',
      tableName: 'tourneo_knex_migrations',
      extension: 'ts',
    },
    seeds: {
      directory: '../seeds',
      extension: 'ts',
    },
  },
  production: {
    client: 'mysql2',
    connection: {
      host: env.db.host,
      port: env.db.port,
      database: env.db.name,
      user: env.db.user,
      password: env.db.password,
      charset: 'utf8mb4',
      timezone: '+00:00',
      // Same verified-TLS policy as the runtime pool; see
      // config/database.ts. Migrations run with the same credentials
      // against the same server and must not be the weaker path in.
      ssl: buildSslOptions(),
    },
    pool: {
      min: env.db.poolMin,
      max: env.db.poolMax,
    },
    migrations: {
      directory: '../migrations',
      tableName: 'tourneo_knex_migrations',
      extension: 'js',
      // In production this knexfile runs as compiled JavaScript from
      // `dist/config/`, so `../migrations` resolves to `dist/migrations`.
      // Pinning loadExtensions is load-bearing: `declaration: true` emits
      // a `.d.ts` next to every migration, and knex's default extension
      // list includes `.ts` — without this it would try to run every type
      // declaration file as a migration.
      loadExtensions: ['.js'],
    },
    seeds: {
      directory: '../seeds',
      extension: 'js',
      loadExtensions: ['.js'],
    },
  },
};

module.exports = config;
export default config;