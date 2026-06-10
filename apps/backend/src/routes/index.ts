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
router.use('/leaderboard', leaderboardRouter); // city/global rankings
router.use('/', americanoRouter); // /events/:id/americano + /americano/matches/:id/score
router.use('/', require('./playNow').playNowRouter); // /play-now + /challenges
router.use('/', require('./engagement').engagementRouter); // /me/feed, /me/challenges, /me/streak, /seasons

// Health check
router.get('/health', (_req, res) => {
  res.json({ success: true, data: { status: 'healthy', version: '1.0.0' } });
});

export { router as apiRouter };