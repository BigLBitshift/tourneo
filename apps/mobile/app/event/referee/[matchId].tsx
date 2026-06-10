/**
 * Referee / Live-Score entry screen
 * - Admin or confirmed participant enters sets
 * - Submits to POST /matches/:id/score
 * - Backend auto-detects winner, updates ELO, next-match
 */
import React, { useCallback, useEffect, useState } from 'react';
import * as Haptics from 'expo-haptics';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useTheme } from '../../../src/providers/ThemeProvider';
import { spacing, fontSize, fontWeight, radius } from '../../../src/theme/spacing';
import type { Colors } from '../../../src/theme/colors';
import {
  getMatchScore,
  postMatchScore,
  type MatchSet,
} from '../../../src/api/v2';
import { shareMatchById } from '../../../src/utils/shareMatch';

export default function RefereeScreen() {
  const { matchId } = useLocalSearchParams<{ matchId: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const id = Number(matchId);

  const [match, setMatch] = useState<any>(null);
  const [sets, setSets] = useState<MatchSet[]>([{ p1: 0, p2: 0 }]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const data = await getMatchScore(id);
        setMatch(data);
      } catch {
        // Not authorised or not found – still allow entry
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  const updateSet = useCallback((idx: number, side: 'p1' | 'p2', delta: number) => {
    setSets((prev) => {
      const next = [...prev];
      const current = next[idx][side];
      next[idx] = { ...next[idx], [side]: Math.max(0, current + delta) };
      return next;
    });
  }, []);

  const addSet = useCallback(() => {
    setSets((prev) => [...prev, { p1: 0, p2: 0 }]);
  }, []);

  const removeSet = useCallback((idx: number) => {
    setSets((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const handleSubmit = useCallback(async () => {
    setSubmitting(true);
    try {
      await postMatchScore(id, sets);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      Alert.alert('Ergebnis gespeichert', 'Das Match-Ergebnis wurde übermittelt.', [
        { text: 'Schließen', style: 'cancel', onPress: () => router.back() },
        {
          text: 'Teilen',
          // Use shareMatchById: the backend has just finalised the match
          // and computed the ELO delta, so the share card contains the
          // sponsor logo and rating change without us reassembling it
          // client-side.
          onPress: async () => {
            await shareMatchById(id);
            router.back();
          },
        },
      ]);
    } catch (err: any) {
      Alert.alert(
        'Fehler',
        err?.response?.data?.error?.message || 'Ergebnis konnte nicht gespeichert werden.'
      );
    } finally {
      setSubmitting(false);
    }
  }, [id, sets, router, match]);

  if (loading) {
    return (
      <View style={[styles.loader, { backgroundColor: colors.bg }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{ title: 'Live-Score', headerShown: true }} />
      <ScrollView contentContainerStyle={{ padding: spacing.lg }}>
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.cardBorder }]}>
          <Text style={[styles.title, { color: colors.textPrimary }]}>
            Match #{match?.match_number || id}
          </Text>
          {match?.round_name && (
            <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
              {match.round_name}
            </Text>
          )}
        </View>

        {sets.map((set, idx) => (
          <View
            key={idx}
            style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.cardBorder }]}
          >
            <View style={styles.setHeader}>
              <Text style={[styles.setLabel, { color: colors.textPrimary }]}>Satz {idx + 1}</Text>
              {sets.length > 1 && (
                <TouchableOpacity onPress={() => removeSet(idx)}>
                  <Text style={{ color: colors.error, fontSize: fontSize.sm }}>✕</Text>
                </TouchableOpacity>
              )}
            </View>
            <View style={styles.scoreRow}>
              <SidePad
                label="Spieler 1"
                value={set.p1}
                onInc={() => updateSet(idx, 'p1', 1)}
                onDec={() => updateSet(idx, 'p1', -1)}
                colors={colors}
              />
              <Text style={[styles.vs, { color: colors.textTertiary }]}>:</Text>
              <SidePad
                label="Spieler 2"
                value={set.p2}
                onInc={() => updateSet(idx, 'p2', 1)}
                onDec={() => updateSet(idx, 'p2', -1)}
                colors={colors}
              />
            </View>
          </View>
        ))}

        <TouchableOpacity
          onPress={addSet}
          style={[styles.addBtn, { borderColor: colors.primary }]}
        >
          <Text style={[styles.addBtnText, { color: colors.primary }]}>+ Satz hinzufügen</Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={handleSubmit}
          disabled={submitting}
          style={[styles.submitBtn, { backgroundColor: colors.primary, opacity: submitting ? 0.6 : 1 }]}
        >
          <Text style={styles.submitBtnText}>
            {submitting ? 'Sende…' : 'Ergebnis bestätigen'}
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

function SidePad({
  label,
  value,
  onInc,
  onDec,
  colors,
}: {
  label: string;
  value: number;
  onInc: () => void;
  onDec: () => void;
  colors: Colors;
}) {
  return (
    <View style={styles.side}>
      <Text style={[styles.sideLabel, { color: colors.textSecondary }]}>{label}</Text>
      <Text style={[styles.sideValue, { color: colors.textPrimary }]}>{value}</Text>
      <View style={styles.sideBtns}>
        <TouchableOpacity
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onDec();
          }}
          style={[styles.sideBtn, { backgroundColor: colors.surfaceSecondary }]}
        >
          <Text style={[styles.sideBtnText, { color: colors.textPrimary }]}>−</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            onInc();
          }}
          style={[styles.sideBtn, { backgroundColor: colors.primary }]}
        >
          <Text style={[styles.sideBtnText, { color: '#fff' }]}>+</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  loader: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  card: {
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    marginBottom: spacing.md,
  },
  title: { fontSize: fontSize.xl, fontWeight: fontWeight.bold },
  subtitle: { fontSize: fontSize.sm, marginTop: 4 },
  setHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  setLabel: { fontSize: fontSize.base, fontWeight: fontWeight.semibold },
  scoreRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  vs: { fontSize: fontSize.xxl, fontWeight: fontWeight.bold, marginHorizontal: spacing.md },
  side: { flex: 1, alignItems: 'center' },
  sideLabel: { fontSize: fontSize.xxs, marginBottom: 4 },
  sideValue: { fontSize: 48, fontWeight: '800', marginBottom: spacing.sm },
  sideBtns: { flexDirection: 'row', gap: spacing.sm },
  sideBtn: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
  },
  sideBtnText: { fontSize: 22, fontWeight: '800' },
  addBtn: {
    padding: spacing.md, borderRadius: radius.md, borderWidth: 1.5,
    alignItems: 'center', marginTop: spacing.sm, borderStyle: 'dashed',
  },
  addBtnText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold },
  submitBtn: {
    padding: spacing.lg, borderRadius: radius.lg,
    alignItems: 'center', marginTop: spacing.lg,
  },
  submitBtnText: { color: '#fff', fontSize: fontSize.base, fontWeight: fontWeight.bold },
});
