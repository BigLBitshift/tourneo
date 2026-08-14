/**
 * Blockierte Nutzer — the other half of blocking.
 *
 * A block the user cannot review or undo is a trap rather than a control,
 * and App Store review looks for the unblock path specifically. Reached
 * from Settings.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Alert,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../src/providers/ThemeProvider';
import { spacing, fontSize, fontWeight, radius } from '../src/theme/spacing';
import { listBlockedUsers, unblockUser } from '../src/api/v2';
import { TAvatar, useToast } from '../src/components/common';

type BlockedUser = {
  user_id: number;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string;
};

export default function BlockedUsersScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const showToast = useToast((s) => s.show);

  const [users, setUsers] = useState<BlockedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setUsers(await listBlockedUsers());
    } catch {
      showToast('error', 'Liste konnte nicht geladen werden');
    }
  }, [showToast]);

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const confirmUnblock = useCallback(
    (user: BlockedUser) => {
      const who = user.display_name || 'Diesen Nutzer';
      Alert.alert(
        `${who} entblocken?`,
        'Ihr könnt euch danach wieder gegenseitig sehen und schreiben.',
        [
          { text: 'Abbrechen', style: 'cancel' },
          {
            text: 'Entblocken',
            onPress: async () => {
              setBusyId(user.user_id);
              try {
                await unblockUser(user.user_id);
                setUsers((prev) => prev.filter((u) => u.user_id !== user.user_id));
                showToast('success', `${who} entblockt`);
              } catch {
                showToast('error', 'Entblocken fehlgeschlagen');
              } finally {
                setBusyId(null);
              }
            },
          },
        ]
      );
    },
    [showToast]
  );

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.bg }]}>
        <Stack.Screen options={{ title: 'Blockierte Nutzer', headerShown: true }} />
        <ActivityIndicator color={colors.primary as string} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <Stack.Screen options={{ title: 'Blockierte Nutzer', headerShown: true }} />

      <FlatList
        data={users}
        keyExtractor={(u) => String(u.user_id)}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary as string}
          />
        }
        renderItem={({ item }) => (
          <View
            style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.cardBorder }]}
          >
            <TAvatar
              size="sm"
              name={item.display_name ?? '?'}
              uri={item.avatar_url ?? undefined}
            />
            <View style={styles.rowBody}>
              <Text style={[styles.name, { color: colors.textPrimary }]} numberOfLines={1}>
                {item.display_name || 'Unbekannter Nutzer'}
              </Text>
              <Text style={[styles.since, { color: colors.textTertiary }]}>
                Blockiert seit {new Date(item.created_at).toLocaleDateString('de-DE')}
              </Text>
            </View>
            <TouchableOpacity
              onPress={() => confirmUnblock(item)}
              disabled={busyId === item.user_id}
              style={[styles.unblockBtn, { borderColor: colors.cardBorder }]}
              accessibilityRole="button"
              accessibilityLabel={`${item.display_name ?? 'Nutzer'} entblocken`}
            >
              {busyId === item.user_id ? (
                <ActivityIndicator size="small" color={colors.primary as string} />
              ) : (
                <Text style={[styles.unblockText, { color: colors.primary }]}>Entblocken</Text>
              )}
            </TouchableOpacity>
          </View>
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons
              name="shield-checkmark-outline"
              size={48}
              color={colors.textTertiary as string}
            />
            <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>
              Niemand blockiert
            </Text>
            <Text style={[styles.emptyText, { color: colors.textTertiary }]}>
              Du kannst jemanden über das Menü auf seinem Profil oder mit einem langen Druck auf
              eine Nachricht blockieren.
            </Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  listContent: { padding: spacing.lg, gap: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
  },
  rowBody: { flex: 1, gap: 2 },
  name: { fontSize: fontSize.base, fontWeight: fontWeight.semibold as any },
  since: { fontSize: fontSize.xs },
  unblockBtn: {
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minWidth: 96,
    alignItems: 'center',
  },
  unblockText: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold as any },
  empty: { alignItems: 'center', paddingTop: 80, paddingHorizontal: spacing.xl, gap: spacing.sm },
  emptyTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.bold as any },
  emptyText: { fontSize: fontSize.sm, textAlign: 'center', lineHeight: 20 },
});
