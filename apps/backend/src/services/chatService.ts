import { db, t } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { NotificationService } from './notificationService';
import { ModerationService } from './moderationService';

export interface ChatMessageRow {
  id: number;
  room_id: number;
  user_id: number;
  message: string;
  created_at: Date;
  display_name?: string | null;
  avatar_url?: string | null;
}

/**
 * ChatService — tournament chat rooms (1 per event).
 *
 * Confirmed participants can read/write. Push notifications are throttled
 * to at most one per recipient per 5 minutes per room.
 */
export class ChatService {
  static readonly PUSH_THROTTLE_MS = 5 * 60 * 1000;

  /**
   * Returns (or creates) the chat room for an event.
   */
  static async getOrCreateRoom(eventId: number): Promise<{ id: number; event_id: number }> {
    let room = await db(t('chat_rooms')).where('event_id', eventId).first();
    if (room) return room;
    const [id] = await db(t('chat_rooms')).insert({
      event_id: eventId,
      created_at: new Date(),
    });
    return { id, event_id: eventId };
  }

  /**
   * Verify that the user is a confirmed participant of the event.
   */
  static async assertParticipant(eventId: number, userId: number): Promise<void> {
    const reg = await db(t('registrations'))
      .where({ event_id: eventId, user_id: userId, status: 'confirmed' })
      .first();
    if (!reg) {
      // Also allow admins
      const user = await db(t('users')).where('id', userId).first();
      if (!user || (user.role !== 'admin' && user.role !== 'superadmin')) {
        throw AppError.forbidden('Only confirmed participants can access this chat');
      }
    }
  }

  /**
   * Returns the latest 50 messages for an event chat, oldest first.
   */
  static async listMessages(eventId: number, userId: number): Promise<ChatMessageRow[]> {
    await this.assertParticipant(eventId, userId);
    const room = await this.getOrCreateRoom(eventId);

    // Blocked users disappear from the conversation, and moderator-hidden
    // messages disappear for everyone. Both filters belong here rather
    // than in the client: a message the reader must not see should never
    // leave the server.
    const hiddenUserIds = await ModerationService.hiddenUserIds(userId);

    const rows = await db(t('chat_messages') + ' as m')
      .leftJoin(t('profiles') + ' as p', 'm.user_id', 'p.user_id')
      .where('m.room_id', room.id)
      .whereNull('m.hidden_at')
      .modify((q) => {
        if (hiddenUserIds.length) q.whereNotIn('m.user_id', hiddenUserIds);
      })
      .orderBy('m.created_at', 'desc')
      .limit(50)
      .select(
        'm.id',
        'm.room_id',
        'm.user_id',
        'm.message',
        'm.created_at',
        'p.display_name',
        'p.avatar_url',
        'p.first_name',
        'p.last_name',
      );

    return rows.reverse();
  }

  /**
   * Post a message to the event chat. Sends throttled push to other participants.
   */
  static async postMessage(eventId: number, userId: number, message: string): Promise<ChatMessageRow> {
    await this.assertParticipant(eventId, userId);
    const trimmed = message.trim();
    if (!trimmed) throw AppError.badRequest('Message cannot be empty');
    if (trimmed.length > 1000) throw AppError.badRequest('Message too long');

    const room = await this.getOrCreateRoom(eventId);
    const now = new Date();
    const [id] = await db(t('chat_messages')).insert({
      room_id: room.id,
      user_id: userId,
      message: trimmed,
      created_at: now,
    });

    const row = await db(t('chat_messages') + ' as m')
      .leftJoin(t('profiles') + ' as p', 'm.user_id', 'p.user_id')
      .where('m.id', id)
      .first(
        'm.id',
        'm.room_id',
        'm.user_id',
        'm.message',
        'm.created_at',
        'p.display_name',
        'p.avatar_url',
      );

    // Async push fan-out (non-blocking errors)
    this.sendChatPush(eventId, room.id, userId, trimmed).catch((err) => {
      console.error('[chat] push fan-out failed:', err);
    });

    return row as ChatMessageRow;
  }

  /**
   * Sends a push to all OTHER confirmed participants, throttled per recipient.
   */
  private static async sendChatPush(
    eventId: number,
    roomId: number,
    senderUserId: number,
    message: string
  ): Promise<void> {
    const event = await db(t('events')).where('id', eventId).first();
    if (!event) return;
    const senderProfile = await db(t('profiles')).where('user_id', senderUserId).first();
    const senderName =
      senderProfile?.display_name ||
      [senderProfile?.first_name, senderProfile?.last_name].filter(Boolean).join(' ') ||
      'Jemand';

    const recipients: { user_id: number }[] = await db(t('registrations'))
      .where({ event_id: eventId, status: 'confirmed' })
      .whereNot('user_id', senderUserId)
      .select('user_id');

    const now = new Date();
    const cutoff = new Date(now.getTime() - this.PUSH_THROTTLE_MS);

    for (const r of recipients) {
      const throttle = await db(t('chat_push_throttle'))
        .where({ room_id: roomId, user_id: r.user_id })
        .first();
      if (throttle && new Date(throttle.last_pushed_at) > cutoff) continue;

      await NotificationService.send(
        r.user_id,
        'general',
        `${event.title}`,
        `${senderName}: ${message.slice(0, 80)}`,
        { event_id: eventId, room_id: roomId, type: 'chat_message' }
      );

      if (throttle) {
        await db(t('chat_push_throttle'))
          .where({ room_id: roomId, user_id: r.user_id })
          .update({ last_pushed_at: now });
      } else {
        await db(t('chat_push_throttle')).insert({
          room_id: roomId,
          user_id: r.user_id,
          last_pushed_at: now,
        });
      }
    }
  }
}
