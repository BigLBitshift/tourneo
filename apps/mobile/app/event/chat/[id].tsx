/**
 * Team chat screen for an event
 * - GET last 50 messages
 * - POST new message (server validates participant)
 * - own messages right (indigo), others left (surface)
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  AppState,
} from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useTheme } from '../../../src/providers/ThemeProvider';
import { spacing, fontSize, fontWeight, radius } from '../../../src/theme/spacing';
import { useAuthStore } from '../../../src/store/authStore';
import { useModerationActions } from '../../../src/hooks/useModerationActions';
import { listChat, postChat } from '../../../src/api/v2';
import * as Haptics from 'expo-haptics';

type ChatMsg = Awaited<ReturnType<typeof listChat>>[number];

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const eventId = Number(id);
  const { colors } = useTheme();
  const { user } = useAuthStore();
  const myUserId = user?.id;

  const [rows, setRows] = useState<ChatMsg[]>([]);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [lastSeenId, setLastSeenId] = useState<number>(0);
  const listRef = useRef<FlatList>(null);
  const { showActions } = useModerationActions();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isActiveRef = useRef<boolean>(true);

  const load = useCallback(async () => {
    try {
      const data = await listChat(eventId);
      setRows((prev) => {
        if (!data) return prev;
        const hasOptimistic = prev.some((m) => m.id < 0);
        const prevTop = prev[prev.length - 1]?.id ?? 0;
        const nextTop = data[data.length - 1]?.id ?? 0;
        if (!hasOptimistic && data.length === prev.length && prevTop === nextTop) return prev;
        if (nextTop > lastSeenId) setLastSeenId(nextTop);
        return data;
      });
    } catch {
      // silent; server may forbid non-participants
    }
  }, [eventId, lastSeenId]);

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, [load]);

  // Adaptive polling: 2s when user is active on chat, 15s in background
  const startPolling = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    const ms = isActiveRef.current ? 2000 : 15000;
    intervalRef.current = setInterval(load, ms);
  }, [load]);

  useEffect(() => {
    startPolling();
    const sub = AppState.addEventListener('change', (state) => {
      isActiveRef.current = state === 'active';
      startPolling();
    });
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      sub.remove();
    };
  }, [startPolling]);

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    const tempId = -Date.now();
    const optimistic: ChatMsg = {
      id: tempId,
      user_id: myUserId ?? 0,
      display_name: user?.display_name ?? 'Du',
      avatar_url: user?.avatar_url ?? null,
      message: trimmed,
      created_at: new Date().toISOString(),
    };
    setRows((prev) => [...prev, optimistic]);
    setText('');
    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
    try {
      await postChat(eventId, trimmed);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      await load();
    } catch {
      // rollback on failure
      setRows((prev) => prev.filter((m) => m.id !== tempId));
      setText(trimmed);
    } finally {
      setSending(false);
    }
  }, [eventId, text, sending, load, myUserId, user?.display_name]);

  const data = useMemo(() => rows, [rows]);

  if (loading) {
    return (
      <View style={[styles.loader, { backgroundColor: colors.bg }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={80}
    >
      <Stack.Screen options={{ title: 'Team-Chat', headerShown: true }} />
      <FlatList
        ref={listRef}
        data={data}
        keyExtractor={(m) => String(m.id)}
        contentContainerStyle={{ padding: spacing.lg, gap: spacing.sm }}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
        renderItem={({ item }) => {
          const mine = item.user_id === myUserId;
          return (
            <TouchableOpacity
              activeOpacity={mine ? 1 : 0.7}
              // Guideline 1.2: every piece of user-generated content needs a
              // reachable report action. Long-press is the platform idiom
              // and keeps the bubble itself uncluttered.
              onLongPress={
                mine
                  ? undefined
                  : () =>
                      showActions({
                        contentType: 'chat_message',
                        contentId: item.id,
                        authorUserId: item.user_id,
                        authorName: item.display_name,
                        onBlocked: load,
                      })
              }
              accessibilityHint={mine ? undefined : 'Gedrückt halten zum Melden oder Blockieren'}
              style={[
                styles.bubble,
                mine
                  ? { alignSelf: 'flex-end', backgroundColor: colors.primary }
                  : { alignSelf: 'flex-start', backgroundColor: colors.surface, borderColor: colors.cardBorder, borderWidth: 1 },
              ]}
            >
              {!mine && (
                <Text style={[styles.author, { color: colors.textTertiary }]}>{item.display_name}</Text>
              )}
              <Text style={[styles.msg, { color: mine ? '#fff' : colors.textPrimary }]}>
                {item.message}
              </Text>
            </TouchableOpacity>
          );
        }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={[styles.emptyText, { color: colors.textTertiary }]}>
              Noch keine Nachrichten.
            </Text>
          </View>
        }
      />
      <View style={[styles.inputRow, { backgroundColor: colors.bg, borderTopColor: colors.border }]}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Nachricht schreiben…"
          placeholderTextColor={colors.textTertiary}
          maxLength={1000}
          style={[styles.input, { backgroundColor: colors.surface, color: colors.textPrimary, borderColor: colors.cardBorder }]}
          multiline
        />
        <TouchableOpacity
          onPress={handleSend}
          disabled={!text.trim() || sending}
          style={[styles.sendBtn, { backgroundColor: colors.primary, opacity: !text.trim() || sending ? 0.5 : 1 }]}
        >
          <Text style={{ color: '#fff', fontSize: fontSize.sm, fontWeight: '700' }}>Senden</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  loader: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  bubble: {
    maxWidth: '80%',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.lg,
  },
  author: { fontSize: fontSize.xxs, marginBottom: 2, fontWeight: fontWeight.semibold },
  msg: { fontSize: fontSize.sm, lineHeight: 20 },
  empty: { padding: spacing.xxl, alignItems: 'center' },
  emptyText: { fontSize: fontSize.sm },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: spacing.sm,
    gap: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    minHeight: 42,
    maxHeight: 120,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.lg,
    borderWidth: 1,
    fontSize: fontSize.sm,
  },
  sendBtn: {
    paddingHorizontal: spacing.md,
    height: 42,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
