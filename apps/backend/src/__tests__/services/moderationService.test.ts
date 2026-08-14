/**
 * The block filter is the piece that has to be right: a one-directional
 * hide lets the blocked party keep replying into a conversation the
 * blocker can no longer see, which is worse than not blocking at all.
 */
let blockRows: Array<{ blocker_user_id: number; blocked_user_id: number }> = [];

jest.mock('../../config/database', () => {
  const dbFn: any = jest.fn(() => ({
    where: () => ({
      orWhere: () => ({
        select: async () => blockRows,
      }),
    }),
  }));
  return { db: dbFn, t: (name: string) => `tourneo_${name}` };
});
jest.mock('../../utils/logger', () => ({
  childLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { ModerationService } from '../../services/moderationService';

describe('ModerationService.hiddenUserIds', () => {
  beforeEach(() => {
    blockRows = [];
  });

  it('hides someone the user blocked', async () => {
    blockRows = [{ blocker_user_id: 1, blocked_user_id: 2 }];
    await expect(ModerationService.hiddenUserIds(1)).resolves.toEqual([2]);
  });

  it('also hides someone who blocked the user — blocking is symmetric in effect', async () => {
    blockRows = [{ blocker_user_id: 2, blocked_user_id: 1 }];
    await expect(ModerationService.hiddenUserIds(1)).resolves.toEqual([2]);
  });

  it('never hides the user from themselves', async () => {
    blockRows = [
      { blocker_user_id: 1, blocked_user_id: 2 },
      { blocker_user_id: 3, blocked_user_id: 1 },
    ];
    const hidden = await ModerationService.hiddenUserIds(1);
    expect(hidden).not.toContain(1);
    expect(hidden.sort()).toEqual([2, 3]);
  });

  it('deduplicates a mutual block', async () => {
    blockRows = [
      { blocker_user_id: 1, blocked_user_id: 2 },
      { blocker_user_id: 2, blocked_user_id: 1 },
    ];
    await expect(ModerationService.hiddenUserIds(1)).resolves.toEqual([2]);
  });

  it('returns an empty list when nobody is blocked', async () => {
    await expect(ModerationService.hiddenUserIds(1)).resolves.toEqual([]);
  });

  it('collects every counterparty across many blocks', async () => {
    blockRows = [
      { blocker_user_id: 1, blocked_user_id: 2 },
      { blocker_user_id: 1, blocked_user_id: 3 },
      { blocker_user_id: 4, blocked_user_id: 1 },
    ];
    const hidden = await ModerationService.hiddenUserIds(1);
    expect(hidden.sort((a, b) => a - b)).toEqual([2, 3, 4]);
  });

  it('coerces ids to numbers so a string id from the driver still filters', async () => {
    blockRows = [{ blocker_user_id: 1, blocked_user_id: '2' as any }];
    const hidden = await ModerationService.hiddenUserIds(1);
    expect(hidden).toEqual([2]);
    expect(typeof hidden[0]).toBe('number');
  });
});

describe('moderation policy', () => {
  it('commits to a 24-hour first-response target', () => {
    // Apple asks for a stated commitment; the queue surfaces breaches
    // against exactly this number.
    expect(ModerationService.REVIEW_SLA_HOURS).toBe(24);
  });
});
