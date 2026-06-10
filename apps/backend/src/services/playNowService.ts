import { v4 as uuidv4 } from 'uuid';
import { db, t } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { PlayerDiscoveryService } from './playerDiscoveryService';
import { NotificationService } from './notificationService';
import { CourtBookingService } from './courtBookingService';

const REQUEST_TTL_HOURS = 3;
const ELO_WINDOW = 100;
const MAX_INVITES = 8;

/**
 * PlayNowService — "Spiel jetzt": one tap finds matching players nearby
 * and (optionally) auto-books a court once everyone accepted.
 *
 * State machine per request:
 *   searching → matched   (enough accepts)
 *   matched   → booked    (slot auto-booked by the requester)
 *   searching/matched → cancelled | expired
 *
 * Open requests need `players_needed` accepts (3 for padel doubles);
 * direct challenges need exactly 1 (the challenged player).
 */
export class PlayNowService {
  static async createOpenRequest(
    requesterId: number,
    opts: { sport?: 'padel' | 'fifa'; city?: string; slot_id?: number }
  ) {
    const sport = opts.sport ?? 'padel';
    const me = await db(t('profiles')).where('user_id', requesterId).first();
    if (!me) throw AppError.notFound('Profile');

    const city = opts.city?.trim() || me.city || undefined;
    const eloCol = sport === 'padel' ? 'elo_padel' : 'elo_fifa';
    const myElo = Number(me[eloCol] ?? 1000);

    // Reuse discovery: same city, ELO window, recently active first.
    const candidates = await PlayerDiscoveryService.search({
      sport,
      eloMin: myElo - ELO_WINDOW,
      eloMax: myElo + ELO_WINDOW,
      city,
      excludeUserId: requesterId,
      limit: MAX_INVITES,
    });
    if (candidates.length < 1) {
      throw AppError.badRequest(
        'Keine passenden Spieler gefunden. Erweitere die Stadt oder versuche es später.'
      );
    }

    return this.createRequest(requesterId, {
      type: 'open',
      sport,
      city: city ?? null,
      playersNeeded: sport === 'padel' ? 3 : 1,
      slotId: opts.slot_id ?? null,
      inviteUserIds: candidates.map((c) => c.user_id),
      pushTitle: 'Spiel jetzt! 🎾',
      pushBody: 'Ein Spieler auf deinem Level sucht Mitspieler. Bist du dabei?',
    });
  }

  static async createDirectChallenge(
    requesterId: number,
    opponentUserId: number,
    opts: { sport?: 'padel' | 'fifa'; slot_id?: number }
  ) {
    if (requesterId === opponentUserId) {
      throw AppError.badRequest('Du kannst dich nicht selbst herausfordern');
    }
    const opponent = await db(t('users'))
      .where('id', opponentUserId)
      .where('status', 'active')
      .whereNull('deleted_at')
      .first();
    if (!opponent) throw AppError.notFound('Player');

    const me = await db(t('profiles')).where('user_id', requesterId).first();
    const myName =
      me?.display_name || [me?.first_name, me?.last_name].filter(Boolean).join(' ') || 'Ein Spieler';

    return this.createRequest(requesterId, {
      type: 'direct',
      sport: opts.sport ?? 'padel',
      city: me?.city ?? null,
      playersNeeded: 1,
      slotId: opts.slot_id ?? null,
      inviteUserIds: [opponentUserId],
      pushTitle: 'Herausforderung! ⚔️',
      pushBody: `${myName} fordert dich zu einem Match heraus.`,
    });
  }

  private static async createRequest(
    requesterId: number,
    params: {
      type: 'open' | 'direct';
      sport: 'padel' | 'fifa';
      city: string | null;
      playersNeeded: number;
      slotId: number | null;
      inviteUserIds: number[];
      pushTitle: string;
      pushBody: string;
    }
  ) {
    const now = new Date();
    const uuid = uuidv4();

    if (params.slotId) {
      const slot = await db(t('court_availability')).where('id', params.slotId).first();
      if (!slot || slot.status !== 'available') {
        throw AppError.badRequest('Der gewählte Slot ist nicht mehr verfügbar');
      }
    }

    const requestId = await db.transaction(async (trx) => {
      const [id] = await trx(t('match_requests')).insert({
        uuid,
        requester_id: requesterId,
        request_type: params.type,
        sport: params.sport,
        city: params.city,
        players_needed: params.playersNeeded,
        slot_id: params.slotId,
        status: 'searching',
        expires_at: new Date(now.getTime() + REQUEST_TTL_HOURS * 60 * 60 * 1000),
        created_at: now,
        updated_at: now,
      });
      await trx(t('match_request_invites')).insert(
        params.inviteUserIds.map((userId) => ({
          request_id: id,
          user_id: userId,
          status: 'invited',
          created_at: now,
        }))
      );
      return id as number;
    });

    // Pushes after commit, capped concurrency is unnecessary at ≤8 invites.
    for (const userId of params.inviteUserIds) {
      NotificationService.send(userId, 'general', params.pushTitle, params.pushBody, {
        match_request_id: requestId,
      }).catch((err) => console.warn('[play-now] invite push failed:', err?.message || err));
    }

    return this.getRequest(requestId);
  }

  static async respond(requestId: number, userId: number, accept: boolean) {
    const now = new Date();

    const outcome = await db.transaction(async (trx) => {
      const request = await trx(t('match_requests')).where('id', requestId).forUpdate().first();
      if (!request) throw AppError.notFound('Match request');
      if (request.status !== 'searching') {
        throw AppError.badRequest('Diese Anfrage ist nicht mehr offen');
      }
      if (new Date(request.expires_at) < now) {
        await trx(t('match_requests')).where('id', requestId).update({
          status: 'expired',
          updated_at: now,
        });
        throw AppError.badRequest('Diese Anfrage ist abgelaufen');
      }

      const invite = await trx(t('match_request_invites'))
        .where({ request_id: requestId, user_id: userId })
        .first();
      if (!invite) throw AppError.forbidden('Du wurdest zu diesem Match nicht eingeladen');
      if (invite.status !== 'invited') {
        throw AppError.badRequest('Du hast bereits geantwortet');
      }

      await trx(t('match_request_invites')).where('id', invite.id).update({
        status: accept ? 'accepted' : 'declined',
        responded_at: now,
      });

      if (!accept) return { matched: false as const, request };

      // Count AFTER our own update — the transaction sees its own write.
      const [{ count }] = await trx(t('match_request_invites'))
        .where({ request_id: requestId, status: 'accepted' })
        .count('* as count');

      if (Number(count) >= request.players_needed) {
        await trx(t('match_requests')).where('id', requestId).update({
          status: 'matched',
          updated_at: now,
        });
        return { matched: true as const, request };
      }
      return { matched: false as const, request };
    });

    // Auto-book outside the transaction (Stripe/lock etiquette like bookSlot).
    if (outcome.matched && outcome.request.slot_id) {
      try {
        const booking = await CourtBookingService.bookSlot(
          outcome.request.slot_id,
          outcome.request.requester_id,
          `Spiel jetzt #${requestId}`
        );
        await db(t('match_requests')).where('id', requestId).update({
          status: 'booked',
          booking_id: booking.id,
          updated_at: new Date(),
        });
      } catch (err) {
        // Slot got taken in the meantime — the match still stands, players
        // pick another slot manually. Never roll back the accepts.
        console.warn('[play-now] auto-book failed:', (err as Error).message);
      }
    }

    if (outcome.matched) {
      const players = await db(t('match_request_invites'))
        .where({ request_id: requestId, status: 'accepted' })
        .pluck('user_id');
      const everyone: number[] = [...players, outcome.request.requester_id];
      for (const uid of everyone) {
        NotificationService.send(
          uid,
          'general',
          'Match steht! 🔥',
          outcome.request.slot_id
            ? 'Alle haben zugesagt — der Platz wird gebucht. Details in der App.'
            : 'Alle haben zugesagt. Stimmt euch in der App über Platz und Zeit ab.',
          { match_request_id: requestId }
        ).catch(() => {});
      }
    }

    return this.getRequest(requestId);
  }

  static async cancel(requestId: number, userId: number) {
    const request = await db(t('match_requests')).where('id', requestId).first();
    if (!request) throw AppError.notFound('Match request');
    if (request.requester_id !== userId) throw AppError.forbidden('Nur der Ersteller kann abbrechen');
    if (!['searching', 'matched'].includes(request.status)) {
      throw AppError.badRequest('Anfrage ist bereits abgeschlossen');
    }
    await db(t('match_requests')).where('id', requestId).update({
      status: 'cancelled',
      updated_at: new Date(),
    });
    return { id: requestId, status: 'cancelled' as const };
  }

  static async getRequest(requestId: number) {
    const request = await db(t('match_requests')).where('id', requestId).first();
    if (!request) throw AppError.notFound('Match request');

    const invites = await db(`${t('match_request_invites')} as i`)
      .leftJoin(`${t('profiles')} as p`, 'p.user_id', 'i.user_id')
      .where('i.request_id', requestId)
      .select(
        'i.user_id',
        'i.status',
        'p.display_name',
        'p.first_name',
        'p.last_name',
        'p.avatar_url'
      );

    return {
      id: request.id,
      uuid: request.uuid,
      requester_id: request.requester_id,
      request_type: request.request_type,
      sport: request.sport,
      city: request.city,
      players_needed: request.players_needed,
      slot_id: request.slot_id,
      booking_id: request.booking_id,
      status: request.status,
      expires_at: request.expires_at,
      invites: invites.map((i: any) => ({
        user_id: i.user_id,
        status: i.status,
        name:
          i.display_name || [i.first_name, i.last_name].filter(Boolean).join(' ') || 'Spieler',
        avatar_url: i.avatar_url ?? null,
      })),
    };
  }

  /** Requests I created + invites waiting for my answer. */
  static async listForUser(userId: number) {
    const mine = await db(t('match_requests'))
      .where('requester_id', userId)
      .whereIn('status', ['searching', 'matched', 'booked'])
      .orderBy('created_at', 'desc')
      .limit(10)
      .pluck('id');

    const invitedTo = await db(t('match_request_invites'))
      .where({ user_id: userId, status: 'invited' })
      .orderBy('created_at', 'desc')
      .limit(10)
      .pluck('request_id');

    const ids = [...new Set([...mine, ...invitedTo])];
    const result = [];
    for (const id of ids) {
      result.push(await this.getRequest(id));
    }
    return result;
  }

  /** Cron: flips overdue searching requests to expired. */
  static async expireStale(now: Date = new Date()): Promise<number> {
    return db(t('match_requests'))
      .where('status', 'searching')
      .where('expires_at', '<', now)
      .update({ status: 'expired', updated_at: now });
  }
}
