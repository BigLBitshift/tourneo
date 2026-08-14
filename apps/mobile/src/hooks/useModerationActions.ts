/**
 * useModerationActions — the "Melden / Blockieren" sheet, in one place.
 *
 * App Store Guideline 1.2 requires that any user-generated content can be
 * reported and any user blocked, from wherever that content appears. Both
 * actions therefore need to exist on chat messages, profiles, reviews and
 * photos alike, and a single hook keeps the wording and the failure
 * handling identical everywhere rather than four near-copies that drift.
 *
 *   const { showActions } = useModerationActions();
 *   <Pressable onLongPress={() => showActions({
 *     contentType: 'chat_message', contentId: m.id,
 *     authorUserId: m.user_id, authorName: m.display_name,
 *     onBlocked: reload,
 *   })} />
 */
import { useCallback } from 'react';
import { Alert } from 'react-native';
import {
  blockUser,
  reportContent,
  type ReportContentType,
  type ReportReason,
} from '../api/v2';
import { useToast } from '../components/common';

const REASONS: Array<{ key: ReportReason; label: string }> = [
  { key: 'harassment', label: 'Belästigung oder Mobbing' },
  { key: 'hate_speech', label: 'Hassrede' },
  { key: 'sexual', label: 'Sexueller Inhalt' },
  { key: 'spam', label: 'Spam oder Werbung' },
  { key: 'other', label: 'Anderer Grund' },
];

export interface ModerationTarget {
  contentType: ReportContentType;
  contentId: number;
  authorUserId?: number | null;
  authorName?: string | null;
  /** Called after a successful block so the screen can drop the content. */
  onBlocked?: () => void;
}

export function useModerationActions() {
  const showToast = useToast((s) => s.show);

  const submitReport = useCallback(
    async (target: ModerationTarget, reason: ReportReason) => {
      try {
        await reportContent({
          contentType: target.contentType,
          contentId: target.contentId,
          reason,
        });
        showToast(
          'success',
          'Danke für die Meldung',
          'Wir prüfen den Inhalt innerhalb von 24 Stunden.'
        );
      } catch (err: any) {
        // A duplicate report is not a failure from the user's side — they
        // already did the right thing.
        if (err?.response?.status === 409) {
          showToast('info', 'Bereits gemeldet', 'Diese Meldung wird schon geprüft.');
          return;
        }
        showToast('error', 'Meldung fehlgeschlagen', 'Bitte versuche es später erneut.');
      }
    },
    [showToast]
  );

  const confirmBlock = useCallback(
    (target: ModerationTarget) => {
      const who = target.authorName || 'diesen Nutzer';
      Alert.alert(
        `${who} blockieren?`,
        'Ihr seht euch gegenseitig nicht mehr — weder Nachrichten noch Aktivitäten. Du kannst das jederzeit in den Einstellungen rückgängig machen.',
        [
          { text: 'Abbrechen', style: 'cancel' },
          {
            text: 'Blockieren',
            style: 'destructive',
            onPress: async () => {
              if (!target.authorUserId) return;
              try {
                await blockUser(target.authorUserId);
                showToast('success', `${who} blockiert`);
                target.onBlocked?.();
              } catch {
                showToast('error', 'Blockieren fehlgeschlagen');
              }
            },
          },
        ]
      );
    },
    [showToast]
  );

  const showReportReasons = useCallback(
    (target: ModerationTarget) => {
      Alert.alert('Warum meldest du das?', undefined, [
        ...REASONS.map((r) => ({
          text: r.label,
          onPress: () => void submitReport(target, r.key),
        })),
        { text: 'Abbrechen', style: 'cancel' as const },
      ]);
    },
    [submitReport]
  );

  const showActions = useCallback(
    (target: ModerationTarget) => {
      const options: Array<{ text: string; style?: 'cancel' | 'destructive'; onPress?: () => void }> =
        [{ text: 'Melden', onPress: () => showReportReasons(target) }];

      // Blocking needs a person to block; content without a known author
      // can still be reported.
      if (target.authorUserId) {
        options.push({
          text: 'Blockieren',
          style: 'destructive',
          onPress: () => confirmBlock(target),
        });
      }
      options.push({ text: 'Abbrechen', style: 'cancel' });

      Alert.alert(target.authorName || 'Inhalt', undefined, options);
    },
    [showReportReasons, confirmBlock]
  );

  return { showActions, showReportReasons, confirmBlock };
}
