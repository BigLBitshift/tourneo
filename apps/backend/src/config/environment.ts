import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const isProduction = process.env.NODE_ENV === 'production';

// Dev-only secret fallbacks. If any of these are observed in production
// validateEnv() below will abort the startup — the hardcoded values must
// never sign real tokens.
const DEV_ACCESS_SECRET = 'dev-access-secret-change-me';
const DEV_REFRESH_SECRET = 'dev-refresh-secret-change-me';

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  apiVersion: process.env.API_VERSION || 'v1',
  isDevelopment: process.env.NODE_ENV === 'development',
  isProduction,

  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    name: process.env.DB_NAME || 'tourneo',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    ssl: process.env.DB_SSL === 'true',
    poolMin: parseInt(process.env.DB_POOL_MIN || '2', 10),
    poolMax: parseInt(process.env.DB_POOL_MAX || '10', 10),
    tablePrefix: process.env.DB_TABLE_PREFIX || 'tourneo_',
  },

  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || DEV_ACCESS_SECRET,
    refreshSecret: process.env.JWT_REFRESH_SECRET || DEV_REFRESH_SECRET,
    accessExpiry: process.env.JWT_ACCESS_EXPIRY || '15m',
    refreshExpiry: process.env.JWT_REFRESH_EXPIRY || '30d',
  },

  /**
   * Feature switches.
   *
   * `payments` covers everything that moves money: tournament entry fees,
   * in-app court payment, and the Plus/Club subscriptions. It is **off by
   * default** so version 1 can ship to the App Store as a free app — no
   * StoreKit, no Stripe activation, no Apple receipt verification, and
   * none of the review surface those bring with them.
   *
   * Switched off, the app is fully usable: tournaments register for free,
   * courts book as pay-at-venue, and every membership tier reports as
   * unavailable rather than pretending to sell something. Nothing is
   * deleted — set PAYMENTS_ENABLED=true once Stripe is live and StoreKit
   * is implemented, and the paid paths come back.
   */
  features: {
    payments: process.env.PAYMENTS_ENABLED === 'true',
  },

  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    apiVersion: process.env.STRIPE_API_VERSION || '2023-10-16',
  },

  apple: {
    sharedSecret: process.env.APPLE_SHARED_SECRET || '',
    bundleId: process.env.APPLE_BUNDLE_ID || 'de.tourneo.app',
    iapEnvironment: process.env.APPLE_IAP_ENVIRONMENT || 'sandbox',
  },

  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID || '',
    privateKeyId: process.env.FIREBASE_PRIVATE_KEY_ID || '',
    privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL || '',
  },

  smtp: {
    host: process.env.SMTP_HOST || 'smtp.ionos.de',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    user: process.env.SMTP_USER || '',
    password: process.env.SMTP_PASSWORD || '',
    fromName: process.env.SMTP_FROM_NAME || 'Tourneo',
    fromEmail: process.env.SMTP_FROM_EMAIL || 'noreply@tourneo.de',
  },

  s3: {
    endpoint: process.env.S3_ENDPOINT || '',
    bucket: process.env.S3_BUCKET || 'tourneo-media',
    accessKey: process.env.S3_ACCESS_KEY || '',
    secretKey: process.env.S3_SECRET_KEY || '',
    region: process.env.S3_REGION || 'eu-central-1',
  },

  app: {
    name: process.env.APP_NAME || 'Tourneo',
    url: process.env.APP_URL || 'http://localhost:3000',
    adminUrl: process.env.ADMIN_URL || 'http://localhost:3001',
    supportEmail: process.env.SUPPORT_EMAIL || 'support@tourneo.de',
  },

  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10),
    authMaxRequests: parseInt(process.env.AUTH_RATE_LIMIT_MAX_REQUESTS || '10', 10),
  },

  logLevel: process.env.LOG_LEVEL || 'debug',
};

/**
 * Aborts startup if the process is running in production without the
 * mandatory configuration. Catches the common "forgot to set JWT secrets"
 * class of deploys where tokens end up signed with the dev fallback,
 * which would make them trivially forgeable.
 *
 * Called from src/index.ts before the HTTP server is bound.
 */
export function validateEnv(): void {
  if (!env.isProduction) return;

  const errors: string[] = [];

  const require = (name: string, value: string, minLen = 1) => {
    if (!value || value.length < minLen) {
      errors.push(
        minLen > 1
          ? `${name} must be set and at least ${minLen} characters in production`
          : `${name} must be set in production`
      );
    }
  };

  require('JWT_ACCESS_SECRET', process.env.JWT_ACCESS_SECRET || '', 32);
  require('JWT_REFRESH_SECRET', process.env.JWT_REFRESH_SECRET || '', 32);
  // Stripe is only mandatory once money is actually being taken. Demanding
  // live keys from a free build would force fake ones into production
  // config, which is how a test key ends up charging real cards later.
  if (env.features.payments) {
    require('STRIPE_SECRET_KEY', env.stripe.secretKey);
    require('STRIPE_WEBHOOK_SECRET', env.stripe.webhookSecret);
  }
  require('APP_URL', process.env.APP_URL || '');
  require('ADMIN_URL', process.env.ADMIN_URL || '');
  require('DB_PASSWORD', env.db.password);

  if (env.jwt.accessSecret === DEV_ACCESS_SECRET || env.jwt.refreshSecret === DEV_REFRESH_SECRET) {
    errors.push('JWT secrets must not use the development fallback values in production');
  }
  if (env.jwt.accessSecret === env.jwt.refreshSecret) {
    errors.push('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ');
  }

  if (errors.length > 0) {
    // eslint-disable-next-line no-console
    console.error('❌ Environment validation failed:\n  - ' + errors.join('\n  - '));
    throw new Error('Invalid production environment: ' + errors.join('; '));
  }
}