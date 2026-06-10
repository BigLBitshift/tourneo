import { db, t } from '../config/database';
import { NotificationService } from '../services/notificationService';

/**
 * Sends a "Dein Platz wartet in ~2h" push for confirmed court bookings
 * starting within the next 105–135 minute window. Each booking is
 * reminded at most once (reminder_sent_at).
 *
 * Runs every 15 minutes — the 30-minute-wide window guarantees no
 * booking falls through between two job runs.
 */
export async function sendBookingReminders(now: Date = new Date()): Promise<number> {
  const windowStart = new Date(now.getTime() + 105 * 60 * 1000);
  const windowEnd = new Date(now.getTime() + 135 * 60 * 1000);

  // slot_date + slot_start live in separate columns; compare on the
  // combined timestamp so bookings around midnight resolve correctly.
  const bookings = await db(t('court_bookings'))
    .join(t('court_availability'), `${t('court_bookings')}.slot_id`, `${t('court_availability')}.id`)
    .leftJoin(t('venues'), `${t('court_bookings')}.venue_id`, `${t('venues')}.id`)
    .leftJoin(t('courts'), `${t('court_bookings')}.court_id`, `${t('courts')}.id`)
    .where(`${t('court_bookings')}.status`, 'confirmed')
    .whereNull(`${t('court_bookings')}.reminder_sent_at`)
    .whereRaw(
      `TIMESTAMP(${t('court_availability')}.slot_date, ${t('court_availability')}.slot_start) BETWEEN ? AND ?`,
      [windowStart, windowEnd]
    )
    .select(
      `${t('court_bookings')}.id as booking_id`,
      `${t('court_bookings')}.user_id`,
      `${t('court_availability')}.slot_start`,
      `${t('venues')}.name as venue_name`,
      `${t('venues')}.address_street as venue_street`,
      `${t('courts')}.name as court_name`
    );

  let sent = 0;
  for (const b of bookings) {
    try {
      const time = String(b.slot_start).slice(0, 5);
      const where = [b.venue_name, b.court_name].filter(Boolean).join(' · ') || 'deinem Platz';
      await NotificationService.send(
        b.user_id,
        'general',
        'Dein Platz wartet! 🎾',
        `Um ${time} Uhr geht's los auf ${where}.${b.venue_street ? ` 📍 ${b.venue_street}` : ''}`,
        { booking_id: b.booking_id }
      );
      await db(t('court_bookings'))
        .where('id', b.booking_id)
        .update({ reminder_sent_at: now, updated_at: now });
      sent++;
    } catch (err) {
      console.error('[bookingReminder] failed for booking', b.booking_id, err);
    }
  }

  return sent;
}
