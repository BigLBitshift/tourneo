import pino from 'pino';
import { env } from '../config/environment';

/**
 * Central structured logger (pino).
 *
 * - JSON output in production (machine-parseable for Loki/Datadog/etc.)
 * - Pretty, human-readable output is left to the consumer: pipe through
 *   `npx pino-pretty` in development (`npm run dev | npx pino-pretty`).
 *
 * Convention: new code should use `logger` instead of console.*.
 * Existing console.* call sites are migrated opportunistically — both
 * end up on stdout, so nothing is lost in the meantime.
 */
export const logger = pino({
  level: env.logLevel || 'info',
  base: { app: 'tourneo-backend' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  redact: {
    // Never log credentials or tokens, even when someone logs a whole
    // request/config object by accident.
    paths: [
      'password',
      '*.password',
      'password_hash',
      '*.password_hash',
      'authorization',
      '*.authorization',
      'access_token',
      '*.access_token',
      'refresh_token',
      '*.refresh_token',
      'identity_token',
      '*.identity_token',
      // The realtime hub authenticates via `?token=` because React
      // Native cannot reliably set headers on a WebSocket upgrade, so a
      // bare `token` field must never survive into a log line either.
      'token',
      '*.token',
    ],
    censor: '[REDACTED]',
  },
});

export function childLogger(component: string) {
  return logger.child({ component });
}
