import {
  generateRoundRobinPairings,
  generateAmericanoRounds,
} from '../../utils/scheduling';

describe('generateRoundRobinPairings', () => {
  it('returns empty for fewer than 2 participants', () => {
    expect(generateRoundRobinPairings([])).toEqual([]);
    expect(generateRoundRobinPairings([1])).toEqual([]);
  });

  it('generates n*(n-1)/2 pairings for even n', () => {
    const pairings = generateRoundRobinPairings([1, 2, 3, 4, 5, 6]);
    expect(pairings).toHaveLength((6 * 5) / 2);
  });

  it('generates n*(n-1)/2 pairings for odd n (with byes)', () => {
    const pairings = generateRoundRobinPairings([1, 2, 3, 4, 5]);
    expect(pairings).toHaveLength((5 * 4) / 2);
  });

  it('every pair meets exactly once', () => {
    const participants = [1, 2, 3, 4, 5, 6, 7, 8];
    const pairings = generateRoundRobinPairings(participants);
    const seen = new Set<string>();
    for (const p of pairings) {
      const key = [p.home, p.away].sort((a, b) => a - b).join('-');
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    expect(seen.size).toBe((8 * 7) / 2);
  });

  it('no participant plays twice in the same round', () => {
    const pairings = generateRoundRobinPairings([1, 2, 3, 4, 5, 6, 7]);
    const byRound = new Map<number, number[]>();
    for (const p of pairings) {
      if (!byRound.has(p.round)) byRound.set(p.round, []);
      byRound.get(p.round)!.push(p.home, p.away);
    }
    for (const players of byRound.values()) {
      expect(new Set(players).size).toBe(players.length);
    }
  });

  it('nobody plays against themselves', () => {
    const pairings = generateRoundRobinPairings([1, 2, 3, 4]);
    for (const p of pairings) {
      expect(p.home).not.toBe(p.away);
    }
  });

  it('uses n-1 rounds for even participant counts', () => {
    const pairings = generateRoundRobinPairings([1, 2, 3, 4, 5, 6]);
    const rounds = new Set(pairings.map((p) => p.round));
    expect(rounds.size).toBe(5);
  });
});

describe('generateAmericanoRounds', () => {
  it('rejects fewer than 4 players', () => {
    expect(() => generateAmericanoRounds([1, 2, 3], 3, 1)).toThrow();
  });

  it('rejects invalid rounds/courts', () => {
    expect(() => generateAmericanoRounds([1, 2, 3, 4], 0, 1)).toThrow();
    expect(() => generateAmericanoRounds([1, 2, 3, 4], 1, 0)).toThrow();
  });

  it('creates the requested number of rounds', () => {
    const plan = generateAmericanoRounds([1, 2, 3, 4, 5, 6, 7, 8], 5, 2);
    expect(plan).toHaveLength(5);
  });

  it('each round uses every player at most once', () => {
    const plan = generateAmericanoRounds([1, 2, 3, 4, 5, 6, 7, 8], 7, 2);
    for (const round of plan) {
      const players = round.matches.flatMap((m) => [...m.teamA, ...m.teamB]);
      expect(new Set(players).size).toBe(players.length);
    }
  });

  it('with 8 players and 2 courts everyone plays every round', () => {
    const plan = generateAmericanoRounds([1, 2, 3, 4, 5, 6, 7, 8], 4, 2);
    for (const round of plan) {
      expect(round.matches).toHaveLength(2);
      expect(round.resting).toHaveLength(0);
    }
  });

  it('with 6 players two rest each round and resting rotates', () => {
    const plan = generateAmericanoRounds([1, 2, 3, 4, 5, 6], 5, 2);
    const allResting = new Set<number>();
    for (const round of plan) {
      expect(round.matches).toHaveLength(1);
      expect(round.resting).toHaveLength(2);
      round.resting.forEach((p) => allResting.add(p));
    }
    // Over 5 rounds the resting spots must hit more than one pair of players.
    expect(allResting.size).toBeGreaterThan(2);
  });

  it('partners vary across rounds', () => {
    const plan = generateAmericanoRounds([1, 2, 3, 4, 5, 6, 7, 8], 6, 2);
    const partnerPairs = new Set<string>();
    for (const round of plan) {
      for (const m of round.matches) {
        partnerPairs.add([...m.teamA].sort((a, b) => a - b).join('-'));
        partnerPairs.add([...m.teamB].sort((a, b) => a - b).join('-'));
      }
    }
    // 6 rounds × 2 matches × 2 teams = 24 team slots. If partners never
    // rotated we would only see 4 distinct pairs; demand meaningful variety.
    expect(partnerPairs.size).toBeGreaterThanOrEqual(10);
  });

  it('court count caps the matches per round', () => {
    const plan = generateAmericanoRounds([1, 2, 3, 4, 5, 6, 7, 8], 3, 1);
    for (const round of plan) {
      expect(round.matches).toHaveLength(1);
      expect(round.resting).toHaveLength(4);
    }
  });
});
