import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import * as path from 'path';
import { createServer } from 'http';
import { env, validateEnv } from './config/environment';
import { db, testConnection } from './config/database';
import { apiRouter } from './routes';
import { startJobs, stopJobs } from './jobs';
import { initLiveBracket } from './realtime/liveBracket';
import { closeHub } from './realtime/hub';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { generalLimiter } from './middleware/rateLimiter';
import {
  sanitizeInput,
  additionalSecurityHeaders,
  requestSizeLimiter,
  preventParamPollution,
} from './middleware/security';

const app = express();

// Trust proxy (for rate limiting behind reverse proxies)
app.set('trust proxy', 1);

// Disable X-Powered-By header
app.disable('x-powered-by');

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(additionalSecurityHeaders);

// CORS
app.use(cors({
  origin: env.isDevelopment ? '*' : [env.app.url, env.app.adminUrl],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept-Language'],
  credentials: true,
  maxAge: 86400, // Cache preflight for 24 hours
}));

// Rate limiting
app.use(generalLimiter);

// Request size limiter (before body parsing)
app.use(requestSizeLimiter(512));

// Logging
app.use(morgan(env.isDevelopment ? 'dev' : 'combined'));

// Body parsing (webhook route needs raw body, handled in route)
app.use((req, res, next) => {
  if (req.originalUrl === `/api/${env.apiVersion}/payments/webhook`) {
    next();
  } else {
    express.json({ limit: '1mb' })(req, res, next);
  }
});
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Input sanitization & parameter pollution prevention
app.use(sanitizeInput);
app.use(preventParamPollution);

// Compression
app.use(compression());

// Static uploads (venue photos etc.)
app.use(
  '/uploads',
  express.static(path.resolve(process.cwd(), 'uploads'), {
    maxAge: '7d',
    fallthrough: true,
  })
);

// API Routes
app.use(`/api/${env.apiVersion}`, apiRouter);

// Public share-link landing pages (tourneo.de/match/:id etc.) — must be
// registered before the 404 handler; lazy import keeps boot order simple.
// eslint-disable-next-line @typescript-eslint/no-var-requires
app.use('/', require('./routes/landing').landingRouter);

// Root route
app.get('/', (_req, res) => {
  res.json({
    name: 'Tourneo API',
    version: '1.0.0',
    status: 'running',
    docs: `/api/${env.apiVersion}/health`,
  });
});

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

/**
 * Graceful shutdown.
 *
 * Without this every deploy severs in-flight requests mid-response and
 * drops every live WebSocket without a close frame, so clients reconnect
 * blind instead of backing off. The sequence matters: stop accepting new
 * connections, then close sockets and jobs, then release the DB pool —
 * closing the pool first would fail the requests we are trying to let
 * finish.
 *
 * The timeout is the backstop: a hung request must not keep a replaced
 * container alive forever.
 */
const SHUTDOWN_TIMEOUT_MS = 15_000;
let shuttingDown = false;

function registerShutdownHandlers(httpServer: import('http').Server): void {
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[shutdown] ${signal} received — draining…`);

    const forceExit = setTimeout(() => {
      console.error('[shutdown] timed out — forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    try {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      console.log('[shutdown] http server closed');

      await closeHub();
      console.log('[shutdown] realtime hub closed');

      await stopJobs();
      console.log('[shutdown] background jobs stopped');

      await db.destroy();
      console.log('[shutdown] database pool drained');

      clearTimeout(forceExit);
      process.exit(0);
    } catch (err) {
      console.error('[shutdown] failed:', err);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // A rejected promise nobody handled used to leave the process running in
  // an unknown state, silently. Log it loudly; do not exit, because a
  // single bad request must not take down the instance.
  process.on('unhandledRejection', (reason) => {
    console.error('[fatal] unhandled promise rejection:', reason);
  });

  // An uncaught exception genuinely does leave the process unsound, so we
  // drain and let the supervisor restart us.
  process.on('uncaughtException', (err) => {
    console.error('[fatal] uncaught exception:', err);
    void shutdown('uncaughtException');
  });
}

// Start server
async function start() {
  // Fail-fast on misconfigured production deploys (e.g. missing JWT
  // secrets) before we accept any traffic.
  validateEnv();

  // Test database connection
  const dbConnected = await testConnection();
  if (!dbConnected) {
    console.warn('⚠️  Database connection failed. Server will start but DB operations will fail.');
    console.warn('   Make sure your .env file has correct DB credentials.');
  }

  // Start background jobs (match reminders etc.)
  if (dbConnected) {
    try {
      startJobs();
    } catch (err) {
      console.warn('⚠️  Failed to start background jobs:', err);
    }
  }

  // Shared HTTP server so the live-bracket WebSocket hub and Express
  // listen on the same port (/ws is upgraded, everything else is HTTP).
  const httpServer = createServer(app);
  initLiveBracket(httpServer);
  registerShutdownHandlers(httpServer);

  httpServer.listen(env.port, () => {
    console.log(`
╔══════════════════════════════════════════╗
║          🏆 TOURNEO API SERVER 🏆         ║
╠══════════════════════════════════════════╣
║  Status:     RUNNING                     ║
║  Port:       ${String(env.port).padEnd(29)}║
║  Env:        ${env.nodeEnv.padEnd(29)}║
║  API:        /api/${env.apiVersion.padEnd(24)}║
║  Database:   ${dbConnected ? 'CONNECTED ✅' : 'DISCONNECTED ❌'}${' '.repeat(dbConnected ? 17 : 14)}║
╚══════════════════════════════════════════╝
    `);
  });
}

start().catch(console.error);

export default app;