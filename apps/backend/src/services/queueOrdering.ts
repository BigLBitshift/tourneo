/**
 * Queue ordering — one definition, every call site.
 *
 * Membership priority on waitlists is an advertised, paid benefit
 * (`routes/membership.ts`), which makes any disagreement between the order
 * shown and the order used a consumer-protection problem, not a cosmetic
 * one. The tournament side of the codebase already drifted this way:
 * promotion sorts tier-first while other readers sort FIFO, so a free-tier
 * user can be shown a position they will never actually get.
 *
 * Court queues put that number on screen next to a live countdown, so the
 * ordering lives here and nowhere else.
 */

export type MembershipTier = 'free' | 'plus' | 'club';

/** Lower sorts first. Exposed so callers can rank in JS without a query. */
export const TIER_RANK: Record<MembershipTier, number> = {
  club: 1,
  plus: 2,
  free: 3,
};

/**
 * SQL ordering fragment for a table carrying `membership_tier_at_join`,
 * `position` and `joined_at`.
 *
 * The tier column is the one captured when the user joined, never the
 * live membership: a queue whose order silently reshuffles overnight
 * because someone's Plus lapsed is worse than one that is merely strict.
 */
export const SLOT_QUEUE_ORDER_SQL = `
  CASE membership_tier_at_join
    WHEN 'club' THEN 1
    WHEN 'plus' THEN 2
    ELSE 3
  END ASC,
  position ASC,
  joined_at ASC,
  id ASC
`;

export interface RankableEntry {
  id: number;
  position: number;
  membership_tier_at_join: MembershipTier;
  joined_at: string | Date;
}

/**
 * Ranks entries exactly as `SLOT_QUEUE_ORDER_SQL` would.
 *
 * Used to compute a user's displayed position and to answer "what would
 * my position be with Plus?" without a second round trip. Sorting a copy
 * keeps the caller's array untouched.
 */
export function sortQueueEntries<T extends RankableEntry>(entries: readonly T[]): T[] {
  return [...entries].sort(compareQueueEntries);
}

export function compareQueueEntries(a: RankableEntry, b: RankableEntry): number {
  const tierDiff = TIER_RANK[a.membership_tier_at_join] - TIER_RANK[b.membership_tier_at_join];
  if (tierDiff !== 0) return tierDiff;
  if (a.position !== b.position) return a.position - b.position;

  const joinedDiff = new Date(a.joined_at).getTime() - new Date(b.joined_at).getTime();
  if (joinedDiff !== 0) return joinedDiff;

  return a.id - b.id;
}

/**
 * 1-based position of `userId` in the queue, or null if absent.
 * This is the number shown to the user, so it must come from the same
 * comparator the promotion path uses.
 */
export function positionOf<T extends RankableEntry & { user_id: number }>(
  entries: readonly T[],
  userId: number
): number | null {
  const index = sortQueueEntries(entries).findIndex((e) => e.user_id === userId);
  return index === -1 ? null : index + 1;
}

/**
 * How many people ahead of `userId`, broken down by tier — the honest
 * version of "2 Club-Mitglieder vor dir", and the input to the upgrade
 * prompt.
 */
export function aheadOf<T extends RankableEntry & { user_id: number }>(
  entries: readonly T[],
  userId: number
): Record<MembershipTier, number> {
  const sorted = sortQueueEntries(entries);
  const index = sorted.findIndex((e) => e.user_id === userId);
  const ahead = index === -1 ? sorted : sorted.slice(0, index);

  return ahead.reduce(
    (acc, e) => {
      acc[e.membership_tier_at_join] += 1;
      return acc;
    },
    { free: 0, plus: 0, club: 0 } as Record<MembershipTier, number>
  );
}

/**
 * The position this user would hold on `tier`, used for the upgrade
 * prompt. Answers the question honestly — including when upgrading would
 * change nothing, so the UI can stay quiet instead of overselling.
 */
export function positionIfTier<T extends RankableEntry & { user_id: number }>(
  entries: readonly T[],
  userId: number,
  tier: MembershipTier
): number | null {
  const hypothetical = entries.map((e) =>
    e.user_id === userId ? { ...e, membership_tier_at_join: tier } : e
  );
  return positionOf(hypothetical, userId);
}
