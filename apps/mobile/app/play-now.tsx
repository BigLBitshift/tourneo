/**
 * Play-Now screen — the "Spiel jetzt" hub.
 *
 * Three sections:
 *   1. Hero "Spiel jetzt" CTA: one tap fires an open match request for
 *      the user's sport + city; the backend invites up to 8 ELO-matched
 *      players. The button is the differentiator.
 *   2. My open requests + pending invites (live status pills).
 *   3. Empty/null states explain the flow when there's no activity yet.
 *
 * Tapping an invite opens an accept/decline sheet; tapping my own
 * request shows the invite roster and lets me cancel.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useTheme } from '../src/providers/ThemeProvider';
import { spacing, fontSize, fontWeight, radius } from '../src/theme/spacing';
import { useAuthStore } from '../src/store/authStore';
import { TModal, useToast } from '../src/components/common';
import {
  createPlayNow,
  listPlayNow,
  respondPlayNow,
  cancelPlayNow,
  type MatchRequest,
} from '../src/api/v2';

const SPORT_LABEL: Record<'padel' | 'fifa', string> = {
  padel: '🏸 Padel',
  fifa: '🎮 FIFA',
};

const STATUS_LABEL: Record<MatchRequest['status'], string> = {
  searching: 'Suche Mitspieler …',
  matched: 'Match steht!',
  booked: 'Platz gebucht ✓',
  cancelled: 'Abgebrochen',
  expired: 'Abgelaufen',
};

export default function PlayNowScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const showToast = useToast((s) => s.show);
  const { user, isAuthenticated } = useAuthStore();

  const [requests, setRequests] = useState<MatchRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [active, setActive] = useState<MatchRequest | null>(null);
  const [responding, setResponding] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await listPlayNow();
      setRequests(data);
    } catch (err: any) {
      console.warn('[play-now] fetch failed', err?.message || err);
    }
  }, []);

  useEffect(() => {
    if (!isAuthenticated) {
      setLoading(false);
      return;
    }
    load().finally(() => setLoading(false));
  }, [load, isAuthenticated]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const startPlayNow = useCallback(async () => {
    if (creating) return;
    if (!isAuthenticated) {
      router.push('/(auth)/login' as any);
      return;
    }
    setCreating(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    try {
      await createPlayNow({ sport: 'padel' });
      showToast(
        'success',
        'Spielanfrage los!',
        'Wir benachrichtigen dich, sobald sich Mitspieler melden.'
      );
      await load();
    } catch (err: any) {
      const msg = err?.response?.data?.error?.message || 'Anfrage konnte nicht gestartet werden.';
      showToast('error', 'Fehlgeschlagen', msg);
    } finally {
      setCreating(false);
    }
  }, [creating, isAuthenticated, router, showToast, load]);

  const respond = useCallback(
    async (accept: boolean) => {
      if (!active || responding) return;
      setResponding(true);
      try {
        const updated = await respondPlayNow(active.id, accept);
        Haptics.notificationAsync(
          accept
            ? Haptics.NotificationFeedbackType.Success
            : Haptics.NotificationFeedbackType.Warning
        ).catch(() => {});
        showToast(
          accept ? 'success' : 'info',
          accept ? 'Zugesagt!' : 'Abgelehnt',
          accept && updated.status === 'matched' ? 'Match steht — viel Spaß!' : undefined
        );
        setActive(null);
        await load();
      } catch (err: any) {
        const msg = err?.response?.data?.error?.message || 'Antwort konnte nicht gesendet werden.';
        showToast('error', 'Fehler', msg);
      } finally {
        setResponding(false);
      }
    },
    [active, responding, showToast, load]
  );

  const cancelMine = useCallback(
    (req: MatchRequest) => {
      Alert.alert('Anfrage abbrechen?', 'Niemand kann sie danach mehr annehmen.', [
        { text: 'Behalten', style: 'cancel' },
        {
          text: 'Abbrechen',
          style: 'destructive',
          onPress: async () => {
            try {
              await cancelPlayNow(req.id);
              showToast('success', 'Abgebrochen');
              await load();
            } catch (err: any) {
              const msg =
                err?.response?.data?.error?.message || 'Abbrechen fehlgeschlagen.';
              showToast('error', 'Fehler', msg);
            }
          },
        },
      ]);
    },
    [showToast, load]
  );

  const { mine, invitesForMe } = useMemo(() => {
    const mineList: MatchRequest[] = [];
    const inviteList: MatchRequest[] = [];
    for (const r of requests) {
      if (r.requester_id === user?.id) mineList.push(r);
      else if (r.invites.some((i) => i.user_id === user?.id && i.status === 'invited')) {
        inviteList.push(r);
      }
    }
    return { mine: mineList, invitesForMe: inviteList };
  }, [requests, user?.id]);

  const myInviteStatus = (req: MatchRequest) =>
    req.invites.find((i) => i.user_id === user?.id)?.status ?? null;

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <Stack.Screen options={{ title: 'Spiel jetzt', headerShown: true }} />

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        }
      >
        <View style={[styles.hero, { backgroundColor: colors.primary }]}>
          <Text style={styles.heroBrand}>SPIEL JETZT</Text>
          <Text style={styles.heroTitle}>Ein Tap. Drei Mitspieler. Ein Platz.</Text>
          <Text style={styles.heroSub}>
            Wir suchen Spieler auf deinem Level in deiner Stadt und reservieren den
            Court automatisch, sobald alle zugesagt haben.
          </Text>
          <TouchableOpacity
            style={[styles.heroCta, creating && { opacity: 0.7 }]}
            disabled={creating}
            onPress={startPlayNow}
            activeOpacity={0.85}
          >
            {creating ? (
              <ActivityIndicator color={colors.primary} />
            ) : (
              <>
                <Ionicons name="flash" size={18} color={colors.primary} />
                <Text style={[styles.heroCtaText, { color: colors.primary }]}>
                  Match starten
                </Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        {loading ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.xxl }} />
        ) : (
          <>
            <SectionHeader title="Einladungen für dich" count={invitesForMe.length} colors={colors} />
            {invitesForMe.length === 0 ? (
              <EmptyHint
                colors={colors}
                text={'Aktuell keine offenen Einladungen. Sobald jemand „Spiel jetzt" startet, taucht es hier auf.'}
              />
            ) : (
              invitesForMe.map((r) => (
                <RequestCard
                  key={r.id}
                  req={r}
                  colors={colors}
                  badge={STATUS_LABEL[r.status]}
                  badgeColor={colors.primary}
                  onPress={() => setActive(r)}
                />
              ))
            )}

            <SectionHeader title="Meine Anfragen" count={mine.length} colors={colors} />
            {mine.length === 0 ? (
              <EmptyHint colors={colors} text="Du hast keine offene Spielanfrage." />
            ) : (
              mine.map((r) => (
                <RequestCard
                  key={r.id}
                  req={r}
                  colors={colors}
                  badge={STATUS_LABEL[r.status]}
                  badgeColor={
                    r.status === 'searching'
                      ? colors.warning
                      : r.status === 'matched' || r.status === 'booked'
                        ? colors.success
                        : colors.textTertiary
                  }
                  onPress={() => setActive(r)}
                  onCancel={r.status === 'searching' ? () => cancelMine(r) : undefined}
                />
              ))
            )}
          </>
        )}
      </ScrollView>

      <TModal
        visible={!!active}
        onClose={() => !responding && setActive(null)}
        title={active?.requester_id === user?.id ? 'Deine Anfrage' : 'Spiel-Einladung'}
      >
        {active && (
          <View style={styles.modalBody}>
            <View style={styles.modalRow}>
              <Text style={[styles.modalLabel, { color: colors.textTertiary }]}>Sport</Text>
              <Text style={[styles.modalValue, { color: colors.textPrimary }]}>
                {SPORT_LABEL[active.sport]}
              </Text>
            </View>
            {active.city && (
              <View style={styles.modalRow}>
                <Text style={[styles.modalLabel, { color: colors.textTertiary }]}>Stadt</Text>
                <Text style={[styles.modalValue, { color: colors.textPrimary }]}>
                  {active.city}
                </Text>
              </View>
            )}
            <View style={styles.modalRow}>
              <Text style={[styles.modalLabel, { color: colors.textTertiary }]}>Status</Text>
              <Text style={[styles.modalValue, { color: colors.textPrimary }]}>
                {STATUS_LABEL[active.status]}
              </Text>
            </View>

            <Text style={[styles.invitesHeader, { color: colors.textTertiary }]}>
              Eingeladen ({active.invites.length})
            </Text>
            <View style={{ gap: 6 }}>
              {active.invites.map((i) => (
                <View
                  key={i.user_id}
                  style={[styles.inviteRow, { borderBottomColor: colors.cardBorder }]}
                >
                  <Text style={[styles.inviteName, { color: colors.textPrimary }]}>
                    {i.name}
                  </Text>
                  <Text
                    style={[
                      styles.inviteStatus,
                      {
                        color:
                          i.status === 'accepted'
                            ? colors.success
                            : i.status === 'declined'
                              ? colors.error
                              : colors.textTertiary,
                      },
                    ]}
                  >
                    {i.status === 'accepted' ? '✓ zugesagt' : i.status === 'declined' ? '× abgelehnt' : 'offen'}
                  </Text>
                </View>
              ))}
            </View>

            {active.requester_id !== user?.id && myInviteStatus(active) === 'invited' && (
              <View style={styles.modalActions}>
                <TouchableOpacity
                  style={[styles.modalBtn, { backgroundColor: colors.surfaceSecondary }]}
                  disabled={responding}
                  onPress={() => respond(false)}
                >
                  <Text style={[styles.modalBtnText, { color: colors.textPrimary }]}>Ablehnen</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.modalBtn, { backgroundColor: colors.primary, opacity: responding ? 0.7 : 1 }]}
                  disabled={responding}
                  onPress={() => respond(true)}
                >
                  {responding ? (
                    <ActivityIndicator color="#FFF" />
                  ) : (
                    <Text style={[styles.modalBtnText, { color: '#FFF' }]}>Zusagen</Text>
                  )}
                </TouchableOpacity>
              </View>
            )}
          </View>
        )}
      </TModal>
    </View>
  );
}

function SectionHeader({
  title,
  count,
  colors,
}: {
  title: string;
  count: number;
  colors: ReturnType<typeof useTheme>['colors'];
}) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={[styles.sectionTitle, { color: colors.textTertiary }]}>
        {title.toUpperCase()}
      </Text>
      <Text style={[styles.sectionCount, { color: colors.textTertiary }]}>· {count}</Text>
    </View>
  );
}

function EmptyHint({
  colors,
  text,
}: {
  colors: ReturnType<typeof useTheme>['colors'];
  text: string;
}) {
  return (
    <View style={[styles.emptyHint, { borderColor: colors.cardBorder }]}>
      <Text style={[styles.emptyText, { color: colors.textTertiary }]}>{text}</Text>
    </View>
  );
}

function RequestCard({
  req,
  colors,
  badge,
  badgeColor,
  onPress,
  onCancel,
}: {
  req: MatchRequest;
  colors: ReturnType<typeof useTheme>['colors'];
  badge: string;
  badgeColor: string;
  onPress: () => void;
  onCancel?: () => void;
}) {
  const accepted = req.invites.filter((i) => i.status === 'accepted').length;
  return (
    <TouchableOpacity
      style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.cardBorder }]}
      onPress={onPress}
      activeOpacity={0.85}
    >
      <View style={styles.cardTop}>
        <Text style={[styles.cardSport, { color: colors.textPrimary }]}>
          {SPORT_LABEL[req.sport]}
        </Text>
        <View style={[styles.badge, { backgroundColor: badgeColor + '22' }]}>
          <Text style={[styles.badgeText, { color: badgeColor }]}>{badge}</Text>
        </View>
      </View>
      <Text style={[styles.cardMeta, { color: colors.textTertiary }]}>
        {req.city ? `${req.city} · ` : ''}
        {accepted}/{req.players_needed} Zusagen
        {req.request_type === 'direct' ? ' · Direkte Herausforderung' : ''}
      </Text>
      {onCancel && (
        <TouchableOpacity onPress={onCancel} style={styles.cardCancel} hitSlop={8}>
          <Text style={[styles.cardCancelText, { color: colors.error }]}>Abbrechen</Text>
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { padding: spacing.lg, paddingBottom: 80 },
  hero: {
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  heroBrand: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: fontSize.xxs,
    fontWeight: '800',
    letterSpacing: 3,
  },
  heroTitle: { color: '#FFF', fontSize: fontSize.xl, fontWeight: '800' as any },
  heroSub: { color: 'rgba(255,255,255,0.85)', fontSize: fontSize.sm, lineHeight: 20 },
  heroCta: {
    marginTop: spacing.sm,
    backgroundColor: '#FFF',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    minHeight: 48,
  },
  heroCtaText: { fontSize: fontSize.base, fontWeight: '800' as any },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 6,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  sectionTitle: {
    fontSize: fontSize.xxs,
    fontWeight: '800' as any,
    letterSpacing: 0.8,
  },
  sectionCount: { fontSize: fontSize.xxs, fontWeight: '800' as any },
  emptyHint: { padding: spacing.lg, borderRadius: radius.md, borderWidth: 1 },
  emptyText: { fontSize: fontSize.xs, textAlign: 'center', lineHeight: 18 },
  card: {
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: 6,
    marginBottom: spacing.sm,
  },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardSport: { fontSize: fontSize.base, fontWeight: '800' as any },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.sm },
  badgeText: {
    fontSize: 10,
    fontWeight: '800' as any,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  cardMeta: { fontSize: fontSize.xs },
  cardCancel: { alignSelf: 'flex-start', marginTop: 4 },
  cardCancelText: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold as any },
  modalBody: { gap: spacing.sm, paddingTop: spacing.xs },
  modalRow: { flexDirection: 'row', justifyContent: 'space-between' },
  modalLabel: {
    fontSize: fontSize.xxs,
    fontWeight: '800' as any,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  modalValue: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold as any },
  invitesHeader: {
    fontSize: fontSize.xxs,
    fontWeight: '800' as any,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginTop: spacing.md,
  },
  inviteRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: spacing.xs,
    borderBottomWidth: 1,
  },
  inviteName: { fontSize: fontSize.sm },
  inviteStatus: { fontSize: fontSize.xs },
  modalActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  modalBtn: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  modalBtnText: { fontSize: fontSize.base, fontWeight: fontWeight.semibold as any },
});
