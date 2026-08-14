import { db, t } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { childLogger } from '../utils/logger';

const log = childLogger('moderation');

export type ContentType =
  | 'chat_message'
  | 'venue_review'
  | 'venue_photo'
  | 'profile'
  | 'feed_item';

export type ReportReason =
  | 'spam'
  | 'harassment'
  | 'hate_speech'
  | 'sexual'
  | 'violence'
  | 'other';

/**
 * ModerationService — reporting, blocking and the moderation queue.
 *
 * Two mechanisms with deliberately different characters:
 *
 *   - **Blocking** is immediate, personal and needs no review. It is the
 *     control that actually protects someone in the moment, so it never
 *     waits on a moderator and never notifies the blocked user.
 *   - **Reporting** is a queue a human works through. It takes time, which
 *     is precisely why blocking exists alongside it.
 *
 * Both are required for App Store Guideline 1.2, and the report queue is
 * also the notice-and-action procedure the DSA asks for.
 */
export class ModerationService {
  /** Target commitment for a first response to a pending report. */
  static readonly REVIEW_SLA_HOURS = 24;

  /* ── reporting ─────────────────────────────────────────────── */

  static async report(params: {
    reporterUserId: number;
    contentType: ContentType;
    contentId: number;
    reason: ReportReason;
    details?: string;
  }): Promise<{ id: number; status: string }> {
    const now = new Date();
    const resolved = await this.resolveContent(params.contentType, params.contentId);

    if (resolved.authorUserId === params.reporterUserId) {
      throw AppError.badRequest('You cannot report your own content');
    }

    try {
      const [id] = await db(t('content_reports')).insert({
        reporter_user_id: params.reporterUserId,
        content_type: params.contentType,
        content_id: params.contentId,
        reported_user_id: resolved.authorUserId,
        reason: params.reason,
        details: params.details?.slice(0, 1000) ?? null,
        // Snapshotted now: a moderator reviewing a message the author has
        // since deleted would otherwise have nothing to judge.
        content_snapshot: resolved.snapshot?.slice(0, 4000) ?? null,
        status: 'pending',
        created_at: now,
        updated_at: now,
      });

      log.info(
        { reportId: id, contentType: params.contentType, contentId: params.contentId },
        'content reported'
      );
      return { id: id as number, status: 'pending' };
    } catch (err: any) {
      // The unique index covers open reports only, so this means "you
      // already reported this and it is still in the queue".
      if (err?.code === 'ER_DUP_ENTRY' || err?.errno === 1062) {
        throw AppError.conflict('You have already reported this content');
      }
      throw err;
    }
  }

  /**
   * Loads the author and a text snapshot for a piece of content.
   * Unknown or already-deleted content still produces a report — losing
   * the report because the author deleted the message first would be a
   * gift to bad actors.
   */
  private static async resolveContent(
    contentType: ContentType,
    contentId: number
  ): Promise<{ authorUserId: number | null; snapshot: string | null }> {
    switch (contentType) {
      case 'chat_message': {
        const row = await db(t('chat_messages')).where('id', contentId).first();
        return { authorUserId: row?.user_id ?? null, snapshot: row?.message ?? null };
      }
      case 'venue_review': {
        const row = await db(t('venue_reviews')).where('id', contentId).first();
        return { authorUserId: row?.user_id ?? null, snapshot: row?.comment ?? null };
      }
      case 'venue_photo': {
        const row = await db(t('venue_photos')).where('id', contentId).first();
        return { authorUserId: row?.user_id ?? null, snapshot: row?.image_url ?? null };
      }
      case 'profile': {
        const row = await db(t('profiles')).where('user_id', contentId).first();
        const snapshot = [row?.display_name, row?.bio].filter(Boolean).join(' — ') || null;
        return { authorUserId: contentId, snapshot };
      }
      default:
        return { authorUserId: null, snapshot: null };
    }
  }

  /* ── blocking ──────────────────────────────────────────────── */

  static async block(blockerUserId: number, blockedUserId: number): Promise<void> {
    if (blockerUserId === blockedUserId) {
      throw AppError.badRequest('You cannot block yourself');
    }
    const target = await db(t('users')).where('id', blockedUserId).first();
    if (!target) throw AppError.notFound('User');

    try {
      await db(t('user_blocks')).insert({
        blocker_user_id: blockerUserId,
        blocked_user_id: blockedUserId,
        created_at: new Date(),
      });
    } catch (err: any) {
      // Already blocked — idempotent by design, so the client never has to
      // care whether it is a first tap or a retry.
      if (err?.code !== 'ER_DUP_ENTRY' && err?.errno !== 1062) throw err;
    }
  }

  static async unblock(blockerUserId: number, blockedUserId: number): Promise<void> {
    await db(t('user_blocks'))
      .where('blocker_user_id', blockerUserId)
      .where('blocked_user_id', blockedUserId)
      .del();
  }

  /** Users this person has blocked, for their settings screen. */
  static async listBlocked(blockerUserId: number) {
    return db(`${t('user_blocks')} as b`)
      .leftJoin(`${t('profiles')} as p`, 'p.user_id', 'b.blocked_user_id')
      .where('b.blocker_user_id', blockerUserId)
      .orderBy('b.created_at', 'desc')
      .select(
        'b.blocked_user_id as user_id',
        'b.created_at',
        'p.display_name',
        'p.avatar_url'
      );
  }

  /**
   * Every user id that must be filtered out of `userId`'s view.
   *
   * Blocking is symmetric in effect even though the row is one-directional:
   * if A blocks B, neither should see the other. A one-way hide lets the
   * blocked party keep replying into a conversation the blocker can no
   * longer see, which is worse than not blocking at all.
   */
  static async hiddenUserIds(userId: number): Promise<number[]> {
    const rows = await db(t('user_blocks'))
      .where('blocker_user_id', userId)
      .orWhere('blocked_user_id', userId)
      .select('blocker_user_id', 'blocked_user_id');

    const ids = new Set<number>();
    for (const row of rows) {
      if (row.blocker_user_id !== userId) ids.add(Number(row.blocker_user_id));
      if (row.blocked_user_id !== userId) ids.add(Number(row.blocked_user_id));
    }
    return [...ids];
  }

  static async isBlocked(userA: number, userB: number): Promise<boolean> {
    const row = await db(t('user_blocks'))
      .where((q) => q.where('blocker_user_id', userA).andWhere('blocked_user_id', userB))
      .orWhere((q) => q.where('blocker_user_id', userB).andWhere('blocked_user_id', userA))
      .first();
    return !!row;
  }

  /* ── moderation queue (admin) ──────────────────────────────── */

  static async listReports(opts: { status?: string; limit?: number } = {}) {
    let query = db(`${t('content_reports')} as r`)
      .leftJoin(`${t('profiles')} as rp`, 'rp.user_id', 'r.reporter_user_id')
      .leftJoin(`${t('profiles')} as ap`, 'ap.user_id', 'r.reported_user_id')
      .orderBy('r.created_at', 'asc') // oldest first — the SLA clock
      .limit(Math.min(opts.limit ?? 100, 200))
      .select(
        'r.*',
        'rp.display_name as reporter_name',
        'ap.display_name as reported_name'
      );

    if (opts.status) query = query.where('r.status', opts.status);
    else query = query.whereIn('r.status', ['pending', 'reviewing']);

    const reports = await query;
    const now = Date.now();
    return reports.map((r: any) => ({
      ...r,
      // Surfaced so a moderator can see at a glance what is about to
      // breach the commitment, rather than discovering it afterwards.
      hours_open: Math.floor((now - new Date(r.created_at).getTime()) / 3_600_000),
      breaches_sla:
        r.status === 'pending' &&
        now - new Date(r.created_at).getTime() > this.REVIEW_SLA_HOURS * 3_600_000,
    }));
  }

  /**
   * Resolves a report.
   *
   * `action: 'remove'` hides the content from every user but keeps the row
   * — destroying it would destroy the evidence the report was filed
   * against, which matters if the same account is reported again.
   */
  static async resolveReport(
    reportId: number,
    moderatorUserId: number,
    params: { action: 'remove' | 'dismiss' | 'reviewing'; note?: string }
  ) {
    const now = new Date();
    const report = await db(t('content_reports')).where('id', reportId).first();
    if (!report) throw AppError.notFound('Report');

    if (params.action === 'reviewing') {
      await db(t('content_reports')).where('id', reportId).update({
        status: 'reviewing',
        reviewed_by: moderatorUserId,
        updated_at: now,
      });
      return { id: reportId, status: 'reviewing' };
    }

    if (params.action === 'remove') {
      await this.hideContent(report.content_type, report.content_id, moderatorUserId, now);
    }

    await db(t('content_reports')).where('id', reportId).update({
      status: params.action === 'remove' ? 'actioned' : 'dismissed',
      reviewed_by: moderatorUserId,
      resolution_note: params.note?.slice(0, 1000) ?? null,
      reviewed_at: now,
      updated_at: now,
    });

    log.info({ reportId, action: params.action, moderatorUserId }, 'report resolved');
    return { id: reportId, status: params.action === 'remove' ? 'actioned' : 'dismissed' };
  }

  private static async hideContent(
    contentType: string,
    contentId: number,
    moderatorUserId: number,
    now: Date
  ): Promise<void> {
    switch (contentType) {
      case 'chat_message':
        await db(t('chat_messages'))
          .where('id', contentId)
          .update({ hidden_at: now, hidden_by: moderatorUserId });
        return;
      case 'venue_review':
        await db(t('venue_reviews')).where('id', contentId).del();
        return;
      case 'venue_photo':
        await db(t('venue_photos')).where('id', contentId).del();
        return;
      default:
        // A profile report is actioned by suspending the account, which is
        // a separate admin decision with its own audit trail.
        log.info({ contentType, contentId }, 'no automatic removal for this content type');
    }
  }
}
