import {
  aheadOf,
  compareQueueEntries,
  positionIfTier,
  positionOf,
  sortQueueEntries,
  SLOT_QUEUE_ORDER_SQL,
  TIER_RANK,
} from '../../services/queueOrdering';

type Tier = 'free' | 'plus' | 'club';

let nextId = 1;
function entry(user_id: number, tier: Tier, position: number, joined = '2026-08-14T10:00:00Z') {
  return { id: nextId++, user_id, membership_tier_at_join: tier, position, joined_at: joined };
}

beforeEach(() => {
  nextId = 1;
});

describe('queue ordering', () => {
  it('ranks club before plus before free', () => {
    expect(TIER_RANK.club).toBeLessThan(TIER_RANK.plus);
    expect(TIER_RANK.plus).toBeLessThan(TIER_RANK.free);
  });

  it('puts a later-joining Club member ahead of an earlier free member', () => {
    const free = entry(1, 'free', 1, '2026-08-14T09:00:00Z');
    const club = entry(2, 'club', 2, '2026-08-14T11:00:00Z');
    expect(sortQueueEntries([free, club]).map((e) => e.user_id)).toEqual([2, 1]);
  });

  it('falls back to FIFO position within a tier', () => {
    const a = entry(1, 'plus', 3);
    const b = entry(2, 'plus', 1);
    const c = entry(3, 'plus', 2);
    expect(sortQueueEntries([a, b, c]).map((e) => e.user_id)).toEqual([2, 3, 1]);
  });

  it('breaks a position tie by join time, then by id', () => {
    const later = entry(1, 'free', 1, '2026-08-14T12:00:00Z');
    const earlier = entry(2, 'free', 1, '2026-08-14T10:00:00Z');
    expect(sortQueueEntries([later, earlier]).map((e) => e.user_id)).toEqual([2, 1]);

    const first = entry(3, 'free', 1);
    const second = entry(4, 'free', 1);
    expect(sortQueueEntries([second, first]).map((e) => e.user_id)).toEqual([3, 4]);
  });

  it('is a total order — sorting is stable and idempotent', () => {
    const entries = [
      entry(1, 'free', 2),
      entry(2, 'club', 5),
      entry(3, 'plus', 1),
      entry(4, 'free', 1),
      entry(5, 'club', 1),
    ];
    const once = sortQueueEntries(entries);
    expect(sortQueueEntries(once)).toEqual(once);
    expect(sortQueueEntries([...entries].reverse())).toEqual(once);
  });

  it('does not mutate the caller array', () => {
    const entries = [entry(1, 'free', 2), entry(2, 'club', 1)];
    const snapshot = [...entries];
    sortQueueEntries(entries);
    expect(entries).toEqual(snapshot);
  });

  it('accepts Date and string join timestamps interchangeably', () => {
    const a = { id: 1, user_id: 1, membership_tier_at_join: 'free' as Tier, position: 1, joined_at: new Date('2026-08-14T12:00:00Z') };
    const b = { id: 2, user_id: 2, membership_tier_at_join: 'free' as Tier, position: 1, joined_at: '2026-08-14T10:00:00Z' };
    expect(compareQueueEntries(a, b)).toBeGreaterThan(0);
  });

  describe('positionOf', () => {
    it('is 1-based and reflects tier priority', () => {
      const entries = [entry(1, 'free', 1), entry(2, 'club', 2), entry(3, 'plus', 3)];
      expect(positionOf(entries, 2)).toBe(1);
      expect(positionOf(entries, 3)).toBe(2);
      expect(positionOf(entries, 1)).toBe(3);
    });

    it('returns null for a user not in the queue', () => {
      expect(positionOf([entry(1, 'free', 1)], 99)).toBeNull();
    });

    it('returns null for an empty queue', () => {
      expect(positionOf([], 1)).toBeNull();
    });
  });

  describe('aheadOf', () => {
    it('counts the people ahead broken down by tier', () => {
      const entries = [
        entry(1, 'club', 1),
        entry(2, 'club', 2),
        entry(3, 'plus', 3),
        entry(4, 'free', 4),
        entry(5, 'free', 5),
      ];
      expect(aheadOf(entries, 4)).toEqual({ club: 2, plus: 1, free: 0 });
    });

    it('reports nobody ahead of the first in line', () => {
      const entries = [entry(1, 'club', 1), entry(2, 'free', 2)];
      expect(aheadOf(entries, 1)).toEqual({ club: 0, plus: 0, free: 0 });
    });

    it('counts the whole queue for a user who has not joined yet', () => {
      const entries = [entry(1, 'club', 1), entry(2, 'plus', 2)];
      expect(aheadOf(entries, 99)).toEqual({ club: 1, plus: 1, free: 0 });
    });
  });

  describe('positionIfTier', () => {
    it('shows the position an upgrade would buy', () => {
      const entries = [
        entry(1, 'free', 1),
        entry(2, 'free', 2),
        entry(3, 'free', 3), // our user
      ];
      expect(positionOf(entries, 3)).toBe(3);
      expect(positionIfTier(entries, 3, 'plus')).toBe(1);
      expect(positionIfTier(entries, 3, 'club')).toBe(1);
    });

    it('is honest when an upgrade changes nothing', () => {
      const entries = [entry(1, 'club', 1), entry(2, 'club', 2), entry(3, 'free', 3)];
      expect(positionOf(entries, 3)).toBe(3);
      // Two Club members still sit ahead — Plus buys nothing here.
      expect(positionIfTier(entries, 3, 'plus')).toBe(3);
      expect(positionIfTier(entries, 3, 'club')).toBe(3);
    });

    it('does not mutate the queue it inspects', () => {
      const entries = [entry(1, 'free', 1)];
      positionIfTier(entries, 1, 'club');
      expect(entries[0].membership_tier_at_join).toBe('free');
    });
  });

  describe('SQL fragment', () => {
    it('encodes the same tier precedence as the comparator', () => {
      const clubIndex = SLOT_QUEUE_ORDER_SQL.indexOf("'club'");
      const plusIndex = SLOT_QUEUE_ORDER_SQL.indexOf("'plus'");
      expect(clubIndex).toBeGreaterThan(-1);
      expect(clubIndex).toBeLessThan(plusIndex);
    });

    it('orders by the tier captured at join, not the live membership', () => {
      expect(SLOT_QUEUE_ORDER_SQL).toContain('membership_tier_at_join');
    });

    it('breaks ties the same way the comparator does', () => {
      expect(SLOT_QUEUE_ORDER_SQL).toContain('position ASC');
      expect(SLOT_QUEUE_ORDER_SQL).toContain('joined_at ASC');
      expect(SLOT_QUEUE_ORDER_SQL).toContain('id ASC');
    });
  });
});
