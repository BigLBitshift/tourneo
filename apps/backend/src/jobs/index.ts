import { Queue, Worker, type JobsOptions } from 'bullmq';
import Redis from 'ioredis';
import { sendMatchReminders } from './matchReminder';
import { sendBookingReminders } from './bookingReminder';
import { pushCityRankChanges } from './cityRankPush';
import { RegistrationService } from '../services/registrationService';
import { CourtBookingService } from '../services/courtBookingService';
import { PlayNowService } from '../services/playNowService';
import { SeasonService } from '../services/seasonService';
import { StreakService } from '../services/streakService';
import { childLogger } from '../utils/logger';

const log = childLogger('jobs');

const QUEUE_NAME = 'tourneo-scheduled';

interface ScheduledJob {
  name: string;
  everyMs: number;
  run: () => Promise<unknown>;
}

/**
 * All recurring background work is declared here once and executed either
 * via BullMQ (when REDIS_URL is set) or a plain in-process setInterval
 * fallback for local development.
 *
 * BullMQ gives us what setInterval cannot:
 *   - exactly-once execution across multiple server instances
 *     (repeatable jobs are deduplicated by the queue)
 *   - jobs survive a process restart
 *   - retry with backoff on failure
 */
const SCHEDULED_JOBS: ScheduledJob[] = [
  {
    name: 'match-reminders',
    everyMs: 5 * 60 * 1000,
    run: () => sendMatchReminders(),
  },
  {
    name: 'waitlist-expiry',
    // Cancels promoted waitlist registrations whose 24h payment window
    // lapsed and promotes the next person. Was previously implemented
    // but never scheduled — expired promotions piled up forever.
    everyMs: 15 * 60 * 1000,
    run: () => RegistrationService.expireUnpaidPromotions(),
  },
  {
    name: 'booking-reminders',
    // "Dein Platz wartet in ~2h" push — reduces no-shows. The job's
    // 30-minute target window is wider than the run interval, so no
    // booking can slip through between runs.
    everyMs: 15 * 60 * 1000,
    run: () => sendBookingReminders(),
  },
  {
    name: 'booking-payment-expiry',
    // Frees slots whose in-app payment was started but never completed
    // (15-minute TTL on pending_payment bookings).
    everyMs: 5 * 60 * 1000,
    run: () => CourtBookingService.expireUnpaidBookings(),
  },
  {
    name: 'play-now-expiry',
    // Flips stale "Spiel jetzt" requests to expired after their 3h TTL.
    everyMs: 15 * 60 * 1000,
    run: () => PlayNowService.expireStale(),
  },
  {
    name: 'season-rollover',
    // Idempotent daily check: snapshots + soft-resets when a quarter ends,
    // ensures an active season row always exists.
    everyMs: 24 * 60 * 60 * 1000,
    run: () => SeasonService.rollover(),
  },
  {
    name: 'streak-warnings',
    // Fri-Sun nudge for players whose weekly streak would break.
    everyMs: 24 * 60 * 60 * 1000,
    run: () => StreakService.warnAtRisk(),
  },
  {
    name: 'city-rank-push',
    // Daily snapshot of padel city ranks; pushes "you dropped to rank N"
    // at most once per 6 days per user.
    everyMs: 24 * 60 * 60 * 1000,
    run: () => pushCityRankChanges(),
  },
];

let started = false;
const intervals: NodeJS.Timeout[] = [];
let queue: Queue | null = null;
let worker: Worker | null = null;
let bullConnection: Redis | null = null;

export function startJobs(): void {
  if (started) return;
  started = true;

  if (process.env.REDIS_URL) {
    startBullMq(process.env.REDIS_URL).catch((err) => {
      log.error({ err }, 'BullMQ startup failed — falling back to in-process timers');
      startIntervalFallback();
    });
  } else {
    startIntervalFallback();
  }
}

async function startBullMq(redisUrl: string): Promise<void> {
  // BullMQ requires its own blocking-capable connection settings —
  // do not reuse the shared client from config/redis.ts.
  bullConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });

  queue = new Queue(QUEUE_NAME, { connection: bullConnection });

  // Register/refresh the repeatable schedule for every declared job.
  // upsertJobScheduler is idempotent: calling it on every boot from every
  // instance converges to a single schedule per job name.
  for (const job of SCHEDULED_JOBS) {
    const opts: JobsOptions = {
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 50 },
      attempts: 3,
      backoff: { type: 'exponential', delay: 10_000 },
    };
    await queue.upsertJobScheduler(job.name, { every: job.everyMs }, { name: job.name, opts });
  }

  worker = new Worker(
    QUEUE_NAME,
    async (bullJob) => {
      const job = SCHEDULED_JOBS.find((j) => j.name === bullJob.name);
      if (!job) {
        log.warn({ jobName: bullJob.name }, 'received unknown job — skipping');
        return;
      }
      return job.run();
    },
    { connection: bullConnection, concurrency: 1 }
  );

  worker.on('failed', (bullJob, err) => {
    log.error({ jobName: bullJob?.name, err }, 'scheduled job failed');
  });

  log.info(
    { jobs: SCHEDULED_JOBS.map((j) => ({ name: j.name, everyMs: j.everyMs })) },
    'background jobs started via BullMQ'
  );
}

function startIntervalFallback(): void {
  for (const job of SCHEDULED_JOBS) {
    const timer = setInterval(() => {
      job.run().catch((err) => {
        log.error({ jobName: job.name, err }, 'scheduled job failed');
      });
    }, job.everyMs);
    intervals.push(timer);
  }
  log.info(
    { jobs: SCHEDULED_JOBS.map((j) => ({ name: j.name, everyMs: j.everyMs })) },
    'background jobs started via in-process timers (set REDIS_URL for BullMQ)'
  );
}

export async function stopJobs(): Promise<void> {
  for (const i of intervals) clearInterval(i);
  intervals.length = 0;

  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
  if (bullConnection) {
    bullConnection.disconnect();
    bullConnection = null;
  }
  started = false;
}
