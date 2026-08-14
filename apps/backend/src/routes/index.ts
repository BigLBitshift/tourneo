import { Router } from 'express';
import { authRouter } from './auth';
import { eventRouter } from './events';
import { registrationRouter } from './registrations';
import { bracketRouter } from './brackets';
import { paymentRouter } from './payments';
import { venueRouter } from './venues';
import { communityRouter } from './community';
import { supportRouter } from './support';
import { legalRouter } from './legal';
import { notificationRouter } from './notifications';
import { adminRouter } from './admin';
import { gdprRouter } from './gdpr';
import { partnerRouter } from './partners';
import { chatRouter } from './chat';
import { meRouter } from './me';
import { playersRouter } from './players';
import { profilesRouter } from './profiles';
import { bookingRouter } from './bookings';
import { leaderboardRouter } from './leaderboard';
import { americanoRouter } from './americano';
import { db } from '../config/database';

const router = Router();

router.use('/auth', authRouter);
router.use('/events', eventRouter);
router.use('/registrations', registrationRouter);
router.use('/matches', bracketRouter);
router.use('/payments', paymentRouter);
router.use('/venues', venueRouter);
router.use('/friends', communityRouter.friendRouter);
router.use('/teams', communityRouter.teamRouter);
router.use('/support', supportRouter);
router.use('/legal', legalRouter);
router.use('/notifications', notificationRouter);
router.use('/admin', adminRouter);
router.use('/', gdprRouter); // /me/data-export, /me/delete-account
router.use('/', partnerRouter); // /events/:id/partners + /partners/:id
router.use('/', chatRouter); // /events/:id/chat
router.use('/me', meRouter); // /me/referral, /me/achievements, /me/next-match
router.use('/players', playersRouter); // /players/search
router.use('/profiles', profilesRouter); // /profiles/:id, /profiles/:id/head-to-head
router.use('/membership', require('./membership').membershipRouter);
router.use('/hall-of-fame', require('./hallOfFame').hallOfFameRouter);
router.use('/bookings', bookingRouter); // court booking
router.use('/slots', require('./slots').slotRouter); // live court queue
router.use('/', require('./moderation').moderationRouter); // /reports, /users/:id/block, /admin/reports
router.use('/leaderboard', leaderboardRouter); // city/global rankings
router.use('/', americanoRouter); // /events/:id/americano + /americano/matches/:id/score
router.use('/', require('./playNow').playNowRouter); // /play-now + /challenges
router.use('/', require('./engagement').engagementRouter); // /me/feed, /me/challenges, /me/streak, /seasons

// Health check
/**
 * Liveness: the process is up and the event loop is turning. Deliberately
 * dependency-free so an orchestrator does not restart a healthy process
 * because the database blipped.
 */
router.get('/health', (_req, res) => {
  res.json({
    success: true,
    data: {
      status: 'healthy',
      version: process.env.APP_VERSION || '1.0.0',
      uptime_seconds: Math.floor(process.uptime()),
    },
  });
});

/**
 * Readiness: can this instance actually serve requests?
 *
 * The previous single health check was a hardcoded string literal that
 * never touched the database, so an uptime monitor reported green while
 * every request 500'd. This one queries, and returns 503 when it cannot —
 * which is what a load balancer needs in order to take the instance out.
 */
router.get('/ready', async (_req, res) => {
  const started = Date.now();
  try {
    await db.raw('SELECT 1');
    res.json({
      success: true,
      data: { status: 'ready', database: 'up', latency_ms: Date.now() - started },
    });
  } catch (error) {
    res.status(503).json({
      success: false,
      error: {
        code: 'NOT_READY',
        message: 'Database unavailable',
      },
      data: { status: 'not_ready', database: 'down', latency_ms: Date.now() - started },
    });
  }
});

export { router as apiRouter };