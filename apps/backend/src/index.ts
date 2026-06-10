import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import * as path from 'path';
import { createServer } from 'http';
import { env, validateEnv } from './config/environment';
import { testConnection } from './config/database';
import { apiRouter } from './routes';
import { startJobs } from './jobs';
import { initLiveBracket } from './realtime/liveBracket';
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