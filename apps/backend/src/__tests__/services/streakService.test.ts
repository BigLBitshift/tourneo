import { isoWeek } from '../../services/streakService';

describe('isoWeek', () => {
  it('computes ISO week with Monday start', () => {
    expect(isoWeek(new Date('2026-01-05'))).toBe('2026-W02'); // Monday
    expect(isoWeek(new Date('2026-01-04'))).toBe('2026-W01'); // Sunday
  });

  it('handles year boundary (ISO week 1 can start in December)', () => {
    expect(isoWeek(new Date('2025-12-29'))).toBe('2026-W01'); // Mon of W1 2026
    expect(isoWeek(new Date('2026-12-31'))).toBe('2026-W53');
  });

  it('pads single-digit weeks', () => {
    expect(isoWeek(new Date('2026-02-10'))).toMatch(/^2026-W0\d$/);
  });

  it('consecutive weeks differ by exactly one', () => {
    const w1 = isoWeek(new Date('2026-06-08'));
    const w2 = isoWeek(new Date('2026-06-15'));
    expect(Number(w2.slice(-2)) - Number(w1.slice(-2))).toBe(1);
  });
});
