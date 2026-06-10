/**
 * Pure tournament-scheduling algorithms — no DB access, fully unit-testable.
 */

export interface RoundRobinPairing<T> {
  round: number;
  home: T;
  away: T;
}

/**
 * Classic circle-method round robin: every participant plays every other
 * participant exactly once. For an odd participant count a BYE slot is
 * inserted; pairings against BYE are skipped (that participant rests).
 *
 * n participants → n-1 rounds (n even) / n rounds (n odd),
 * n*(n-1)/2 pairings total.
 */
export function generateRoundRobinPairings<T>(participants: T[]): RoundRobinPairing<T>[] {
  if (participants.length < 2) return [];

  const BYE = Symbol('bye');
  const ring: Array<T | typeof BYE> = [...participants];
  if (ring.length % 2 !== 0) ring.push(BYE);

  const n = ring.length;
  const rounds = n - 1;
  const pairings: RoundRobinPairing<T>[] = [];

  // Fixed first element; the rest rotates clockwise each round.
  const rotating = ring.slice(1);

  for (let round = 1; round <= rounds; round++) {
    const current = [ring[0], ...rotating];
    for (let i = 0; i < n / 2; i++) {
      const home = current[i];
      const away = current[n - 1 - i];
      if (home === BYE || away === BYE) continue;
      // Alternate home/away so the fixed participant doesn't always play "home".
      if (round % 2 === 0) {
        pairings.push({ round, home: away as T, away: home as T });
      } else {
        pairings.push({ round, home: home as T, away: away as T });
      }
    }
    // rotate: last element moves to the front of the rotating part
    rotating.unshift(rotating.pop()!);
  }

  return pairings;
}

export interface AmericanoMatch<T> {
  round: number;
  court: number;
  teamA: [T, T];
  teamB: [T, T];
}

export interface AmericanoRoundPlan<T> {
  matches: AmericanoMatch<T>[];
  /** Players sitting out this round (participant count not divisible by 4). */
  resting: T[];
}

/**
 * Americano rotation: players change partners every round so everyone
 * plays with and against as many different people as possible. Points are
 * accumulated individually.
 *
 * Implementation: a circle rotation (like round robin) determines the
 * player order per round; consecutive groups of four become one match of
 * pairs (1st+4th vs 2nd+3rd — the crossing maximises partner variety).
 * Players beyond the largest multiple of four rest for that round; the
 * rotation guarantees resting is spread across different players.
 */
export function generateAmericanoRounds<T>(
  players: T[],
  roundsCount: number,
  courtsCount: number
): AmericanoRoundPlan<T>[] {
  if (players.length < 4) {
    throw new Error('Americano requires at least 4 players');
  }
  if (roundsCount < 1) {
    throw new Error('roundsCount must be >= 1');
  }
  if (courtsCount < 1) {
    throw new Error('courtsCount must be >= 1');
  }

  const ring = [...players];
  const n = ring.length;
  const rotating = ring.slice(1);
  const plans: AmericanoRoundPlan<T>[] = [];

  for (let round = 1; round <= roundsCount; round++) {
    const order = [ring[0], ...rotating];
    const playable = Math.min(
      Math.floor(n / 4) * 4,
      courtsCount * 4
    );

    const matches: AmericanoMatch<T>[] = [];
    for (let i = 0; i + 3 < playable; i += 4) {
      matches.push({
        round,
        court: i / 4 + 1,
        teamA: [order[i], order[i + 3]],
        teamB: [order[i + 1], order[i + 2]],
      });
    }
    plans.push({ matches, resting: order.slice(playable) });

    rotating.unshift(rotating.pop()!);
  }

  return plans;
}
