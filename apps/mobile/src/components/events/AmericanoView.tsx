/**
 * AmericanoView — full Americano session display for the event detail
 * screen. Splits matches into rounds, lets participants tap a match to
 * enter a score (sum is enforced server-side against points_per_match),
 * and shows the individual points standings below.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  TextInput,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useTheme } from '../../providers/ThemeProvider';
import { spacing, fontSize, fontWeight, radius } from '../../theme/spacing';
import {
  getAmericanoSession,
  getAmericanoStandings,
  postAmericanoScore,
  type AmericanoSession,
  type AmericanoMatchView,
  type AmericanoStanding,
} from '../../api/v2';
import { TModal, useToast } from '../common';

interface AmericanoViewProps {
  eventId: number;
  /** When provided, the user can score their own matches. */
  currentUserId?: number;
  /**
   * When false (default), the component renders null while loading and
   * when no session exists — so it can be dropped into any event detail
   * screen without occupying space for non-Americano events.
   */
  showWhenEmpty?: boolean;
}

export const AmericanoView: React.FC<AmericanoViewProps> = ({
  eventId,
  currentUserId,
  showWhenEmpty = false,
}) => {
  const { colors } = useTheme();
  const showToast = useToast((s) => s.show);
  const [session, setSession] = useState<AmericanoSession | null>(null);
  const [standings, setStandings] = useState<AmericanoStanding[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [scoreTarget, setScoreTarget] = useState<AmericanoMatchView | null>(null);
  const [scoreA, setScoreA] = useState('');
  const [scoreB, setScoreB] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await getAmericanoSession(eventId);
      setSession(s);
      if (s) {
        try {
          const st = await getAmericanoStandings(eventId);
          setStandings(st);
        } catch {
          setStandings([]);
        }
      }
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    load();
  }, [load]);

  const rounds = useMemo(() => {
    if (!session) return [];
    const byRound = new Map<number, AmericanoMatchView[]>();
    for (const m of session.matches) {
      if (!byRound.has(m.round_number)) byRound.set(m.round_number, []);
      byRound.get(m.round_number)!.push(m);
    }
    return [...byRound.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([round, matches]) => ({
        round,
        matches: matches.sort((a, b) => a.court_number - b.court_number),
      }));
  }, [session]);

  const isMyMatch = useCallback(
    (m: AmericanoMatchView): boolean => {
      if (!currentUserId) return false;
      return [...m.team_a, ...m.team_b].some((p) => p.user_id === currentUserId);
    },
    [currentUserId]
  );

  const openScore = (m: AmericanoMatchView) => {
    if (m.status === 'completed') return;
    if (!isMyMatch(m)) {
      Alert.alert('Nicht teilnahmeberechtigt', 'Nur Mitspieler dieses Matches können Ergebnisse eintragen.');
      return;
    }
    setScoreTarget(m);
    setScoreA('');
    setScoreB('');
  };

  const saveScore = async () => {
    if (!scoreTarget || !session) return;
    const a = parseInt(scoreA, 10);
    const b = parseInt(scoreB, 10);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) {
      Alert.alert('Ungültiges Ergebnis', 'Beide Punkte müssen ganze Zahlen ≥ 0 sein.');
      return;
    }
    if (a + b !== session.points_per_match) {
      Alert.alert(
        'Falsche Summe',
        `Die Punkte müssen zusammen ${session.points_per_match} ergeben (aktuell ${a + b}).`
      );
      return;
    }
    setSaving(true);
    try {
      await postAmericanoScore(scoreTarget.id, a, b);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      showToast('success', 'Ergebnis gespeichert');
      setScoreTarget(null);
      await load();
    } catch (err: any) {
      const msg = err?.response?.data?.error?.message || 'Speichern fehlgeschlagen.';
      showToast('error', 'Fehler', msg);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    if (!showWhenEmpty) return null;
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }
  if (!session) {
    if (!showWhenEmpty) return null;
    return (
      <View style={[styles.placeholder, { borderColor: colors.cardBorder }]}>
        <Text style={[styles.placeholderText, { color: colors.textTertiary }]}>
          Noch keine Americano-Session erstellt.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.meta}>
        <MetaPill colors={colors} label="Runden" value={String(session.rounds_count)} />
        <MetaPill colors={colors} label="Courts" value={String(session.courts_count)} />
        <MetaPill colors={colors} label="Punkte" value={String(session.points_per_match)} />
        <MetaPill
          colors={colors}
          label="Status"
          value={
            session.status === 'completed'
              ? 'Beendet'
              : session.status === 'in_progress'
                ? 'Live'
                : 'Entwurf'
          }
        />
      </View>

      {rounds.map(({ round, matches }) => (
        <View key={round} style={styles.roundBlock}>
          <Text style={[styles.roundTitle, { color: colors.textTertiary }]}>
            Runde {round}
          </Text>
          {matches.map((m) => (
            <MatchRow
              key={m.id}
              match={m}
              isMine={isMyMatch(m)}
              onPress={() => openScore(m)}
              colors={colors}
            />
          ))}
        </View>
      ))}

      {standings && standings.length > 0 && (
        <View style={[styles.standingsCard, { backgroundColor: colors.surface, borderColor: colors.cardBorder }]}>
          <Text style={[styles.standingsTitle, { color: colors.textPrimary }]}>
            Einzelwertung
          </Text>
          {standings.map((s) => {
            const isMe = currentUserId === s.user_id;
            return (
              <View
                key={s.user_id}
                style={[
                  styles.standingsRow,
                  {
                    borderBottomColor: colors.cardBorder,
                    backgroundColor: isMe ? colors.primary + '14' : 'transparent',
                  },
                ]}
              >
                <Text style={[styles.standingsRank, { color: colors.textPrimary }]}>
                  {s.rank}
                </Text>
                <Text
                  style={[
                    styles.standingsName,
                    {
                      color: colors.textPrimary,
                      fontWeight: isMe ? '800' : (fontWeight.semibold as any),
                    },
                  ]}
                  numberOfLines={1}
                >
                  {s.name}
                </Text>
                <Text style={[styles.standingsStat, { color: colors.textSecondary }]}>
                  {s.wins}/{s.played}
                </Text>
                <Text style={[styles.standingsPoints, { color: colors.primary }]}>
                  {s.points}
                </Text>
              </View>
            );
          })}
        </View>
      )}

      <TModal
        visible={!!scoreTarget}
        onClose={() => !saving && setScoreTarget(null)}
        title="Ergebnis eintragen"
      >
        {scoreTarget && (
          <View style={styles.modalContent}>
            <Text style={[styles.modalSubtitle, { color: colors.textTertiary }]}>
              Punkte müssen zusammen {session.points_per_match} ergeben.
            </Text>
            <View style={styles.scoreInputs}>
              <View style={styles.scoreSide}>
                <Text style={[styles.scoreSideLabel, { color: colors.textTertiary }]}>Team A</Text>
                <Text
                  style={[styles.scoreSideNames, { color: colors.textPrimary }]}
                  numberOfLines={1}
                >
                  {scoreTarget.team_a.map((p) => p.name.split(' ')[0]).join(' & ')}
                </Text>
                <TextInput
                  value={scoreA}
                  onChangeText={setScoreA}
                  keyboardType="number-pad"
                  maxLength={2}
                  placeholder="0"
                  placeholderTextColor={colors.textTertiary}
                  style={[
                    styles.scoreInput,
                    { color: colors.textPrimary, borderColor: colors.cardBorder },
                  ]}
                />
              </View>
              <Text style={[styles.scoreDivider, { color: colors.textTertiary }]}>:</Text>
              <View style={styles.scoreSide}>
                <Text style={[styles.scoreSideLabel, { color: colors.textTertiary }]}>Team B</Text>
                <Text
                  style={[styles.scoreSideNames, { color: colors.textPrimary }]}
                  numberOfLines={1}
                >
                  {scoreTarget.team_b.map((p) => p.name.split(' ')[0]).join(' & ')}
                </Text>
                <TextInput
                  value={scoreB}
                  onChangeText={setScoreB}
                  keyboardType="number-pad"
                  maxLength={2}
                  placeholder="0"
                  placeholderTextColor={colors.textTertiary}
                  style={[
                    styles.scoreInput,
                    { color: colors.textPrimary, borderColor: colors.cardBorder },
                  ]}
                />
              </View>
            </View>
            <TouchableOpacity
              style={[styles.saveBtn, { backgroundColor: colors.primary, opacity: saving ? 0.7 : 1 }]}
              disabled={saving}
              onPress={saveScore}
            >
              {saving ? (
                <ActivityIndicator color="#FFF" />
              ) : (
                <Text style={styles.saveBtnText}>Speichern</Text>
              )}
            </TouchableOpacity>
          </View>
        )}
      </TModal>
    </View>
  );
};

function MetaPill({
  colors,
  label,
  value,
}: {
  colors: ReturnType<typeof useTheme>['colors'];
  label: string;
  value: string;
}) {
  return (
    <View style={[styles.metaPill, { backgroundColor: colors.surfaceSecondary }]}>
      <Text style={[styles.metaLabel, { color: colors.textTertiary }]}>{label}</Text>
      <Text style={[styles.metaValue, { color: colors.textPrimary }]}>{value}</Text>
    </View>
  );
}

function MatchRow({
  match,
  isMine,
  onPress,
  colors,
}: {
  match: AmericanoMatchView;
  isMine: boolean;
  onPress: () => void;
  colors: ReturnType<typeof useTheme>['colors'];
}) {
  const done = match.status === 'completed';
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={done ? 1 : 0.8}
      disabled={done && !isMine}
      style={[
        styles.matchRow,
        {
          backgroundColor: colors.surface,
          borderColor: isMine ? colors.primary + '55' : colors.cardBorder,
        },
      ]}
    >
      <View style={styles.matchCourt}>
        <Text style={[styles.courtNum, { color: colors.textTertiary }]}>C{match.court_number}</Text>
      </View>
      <View style={styles.matchPlayers}>
        <Text style={[styles.teamLine, { color: colors.textPrimary }]} numberOfLines={1}>
          {match.team_a.map((p) => p.name.split(' ')[0]).join(' & ')}
        </Text>
        <Text style={[styles.vsLine, { color: colors.textTertiary }]}>vs</Text>
        <Text style={[styles.teamLine, { color: colors.textPrimary }]} numberOfLines={1}>
          {match.team_b.map((p) => p.name.split(' ')[0]).join(' & ')}
        </Text>
      </View>
      <View style={styles.matchScore}>
        {done ? (
          <Text style={[styles.scoreLine, { color: colors.primary }]}>
            {match.score_a}–{match.score_b}
          </Text>
        ) : isMine ? (
          <View style={[styles.enterBtn, { backgroundColor: colors.primary + '22' }]}>
            <Ionicons name="create-outline" size={14} color={colors.primary} />
            <Text style={[styles.enterBtnText, { color: colors.primary }]}>Ergebnis</Text>
          </View>
        ) : (
          <Text style={[styles.pendingText, { color: colors.textTertiary }]}>—</Text>
        )}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.md },
  center: { paddingVertical: spacing.lg, alignItems: 'center' },
  placeholder: {
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    alignItems: 'center',
  },
  placeholderText: { fontSize: fontSize.sm, textAlign: 'center' },
  meta: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  metaPill: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.md,
    minWidth: 70,
  },
  metaLabel: {
    fontSize: fontSize.xxs,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    fontWeight: fontWeight.semibold as any,
  },
  metaValue: { fontSize: fontSize.base, fontWeight: '800' as any },
  roundBlock: { gap: spacing.xs },
  roundTitle: {
    fontSize: fontSize.xxs,
    fontWeight: fontWeight.bold as any,
    textTransform: 'uppercase',
    letterSpacing: 0.7,
    marginTop: spacing.sm,
  },
  matchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    gap: spacing.md,
  },
  matchCourt: { width: 32 },
  courtNum: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold as any,
    letterSpacing: 0.5,
  },
  matchPlayers: { flex: 1 },
  teamLine: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold as any },
  vsLine: { fontSize: fontSize.xxs, marginVertical: 2 },
  matchScore: { minWidth: 80, alignItems: 'flex-end' },
  scoreLine: { fontSize: fontSize.lg, fontWeight: '800' as any },
  pendingText: { fontSize: fontSize.lg },
  enterBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.md,
  },
  enterBtnText: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold as any },
  standingsCard: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
  },
  standingsTitle: {
    fontSize: fontSize.base,
    fontWeight: '800' as any,
    marginBottom: spacing.sm,
  },
  standingsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
  },
  standingsRank: { width: 28, fontSize: fontSize.sm, fontWeight: fontWeight.bold as any },
  standingsName: { flex: 1, fontSize: fontSize.sm, paddingRight: spacing.sm },
  standingsStat: { width: 56, textAlign: 'right', fontSize: fontSize.sm },
  standingsPoints: { width: 48, textAlign: 'right', fontSize: fontSize.base, fontWeight: '800' as any },
  modalContent: { gap: spacing.md, paddingTop: spacing.sm },
  modalSubtitle: { fontSize: fontSize.xs, textAlign: 'center' },
  scoreInputs: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  scoreSide: { flex: 1, alignItems: 'center', gap: spacing.xs },
  scoreSideLabel: {
    fontSize: fontSize.xxs,
    fontWeight: fontWeight.bold as any,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  scoreSideNames: { fontSize: fontSize.xs, textAlign: 'center' },
  scoreInput: {
    width: 80,
    height: 60,
    borderWidth: 1,
    borderRadius: radius.md,
    fontSize: 28,
    fontWeight: '800',
    textAlign: 'center',
  },
  scoreDivider: { fontSize: 28, fontWeight: '800', marginTop: 32 },
  saveBtn: {
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
    minHeight: 48,
    justifyContent: 'center',
  },
  saveBtnText: { color: '#FFF', fontSize: fontSize.base, fontWeight: fontWeight.bold as any },
});
