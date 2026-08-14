jest.mock('../../config/database', () => ({
  db: jest.fn(),
  t: (name: string) => `tourneo_${name}`,
}));
jest.mock('../../services/notificationService', () => ({
  NotificationService: { send: jest.fn() },
}));

import { isQuietHour, type NotificationPrefs } from '../../services/slotNotifier';

const prefs = (patch: Partial<NotificationPrefs> = {}): NotificationPrefs => ({
  timezone: 'Europe/Berlin',
  quiet_hours_start: '22:00:00',
  quiet_hours_end: '08:00:00',
  slot_alerts_enabled: true,
  pause_offers_during_quiet_hours: false,
  max_slot_alerts_per_day: 5,
  ...patch,
});

/** Builds an instant from a Berlin wall-clock time in August (CEST, +2). */
const berlinSummer = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 7, 14, h - 2, m));
};

describe('isQuietHour', () => {
  it('is quiet late at night and early in the morning', () => {
    expect(isQuietHour(berlinSummer('23:30'), prefs())).toBe(true);
    expect(isQuietHour(berlinSummer('03:00'), prefs())).toBe(true);
    expect(isQuietHour(berlinSummer('07:59'), prefs())).toBe(true);
  });

  it('is not quiet during the day', () => {
    expect(isQuietHour(berlinSummer('08:00'), prefs())).toBe(false);
    expect(isQuietHour(berlinSummer('14:00'), prefs())).toBe(false);
    expect(isQuietHour(berlinSummer('21:59'), prefs())).toBe(false);
  });

  it('treats the window as start-inclusive and end-exclusive', () => {
    expect(isQuietHour(berlinSummer('22:00'), prefs())).toBe(true);
    expect(isQuietHour(berlinSummer('08:00'), prefs())).toBe(false);
  });

  it('handles a window that does not wrap midnight', () => {
    const daytime = prefs({ quiet_hours_start: '09:00:00', quiet_hours_end: '17:00:00' });
    expect(isQuietHour(berlinSummer('12:00'), daytime)).toBe(true);
    expect(isQuietHour(berlinSummer('08:00'), daytime)).toBe(false);
    expect(isQuietHour(berlinSummer('18:00'), daytime)).toBe(false);
  });

  it('resolves the local wall clock through the user timezone, not the server', () => {
    // 22:30 Berlin is 21:30 in London — past quiet hours there, not here.
    const instant = berlinSummer('22:30');
    expect(isQuietHour(instant, prefs())).toBe(true);
    expect(isQuietHour(instant, prefs({ timezone: 'Europe/London' }))).toBe(false);
  });

  it('respects winter time', () => {
    // 22:30 Berlin in January is 21:30 UTC.
    const januaryEvening = new Date(Date.UTC(2026, 0, 14, 21, 30));
    expect(isQuietHour(januaryEvening, prefs())).toBe(true);
    // 21:30 Berlin is 20:30 UTC — still before quiet hours.
    expect(isQuietHour(new Date(Date.UTC(2026, 0, 14, 20, 30)), prefs())).toBe(false);
  });

  it('is never quiet when either bound is unset', () => {
    expect(isQuietHour(berlinSummer('03:00'), prefs({ quiet_hours_start: null }))).toBe(false);
    expect(isQuietHour(berlinSummer('03:00'), prefs({ quiet_hours_end: null }))).toBe(false);
  });

  it('treats an empty window as never quiet rather than always quiet', () => {
    const degenerate = prefs({ quiet_hours_start: '22:00:00', quiet_hours_end: '22:00:00' });
    expect(isQuietHour(berlinSummer('22:00'), degenerate)).toBe(false);
    expect(isQuietHour(berlinSummer('03:00'), degenerate)).toBe(false);
  });

  it('falls back to Europe/Berlin for a blank timezone', () => {
    expect(isQuietHour(berlinSummer('23:30'), prefs({ timezone: '' }))).toBe(true);
  });
});
