import knex, { Knex } from 'knex';
import { env } from './environment';
import { buildSslOptions } from './dbSsl';

const knexConfig: Knex.Config = {
  client: 'mysql2',
  connection: {
    host: env.db.host,
    port: env.db.port,
    database: env.db.name,
    user: env.db.user,
    password: env.db.password,
    charset: 'utf8mb4',
    timezone: '+00:00',
    ...(env.db.ssl ? { ssl: buildSslOptions() } : {}),
  },
  pool: {
    min: env.db.poolMin,
    max: env.db.poolMax,
    acquireTimeoutMillis: 30000,
    createTimeoutMillis: 30000,
    destroyTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    reapIntervalMillis: 1000,
    createRetryIntervalMillis: 100,
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
};

export const db = knex(knexConfig);

export const t = (tableName: string): string => `${env.db.tablePrefix}${tableName}`;

export async function testConnection(): Promise<boolean> {
  try {
    await db.raw('SELECT 1');
    console.log('✅ Database connection established successfully');
    return true;
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    return false;
  }
}

export default knexConfig;