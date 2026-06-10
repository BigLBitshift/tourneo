/**
 * StandingsTable — round-robin league table.
 *
 * Self-fetches on mount from /matches/events/:id/standings. Renders an
 * empty placeholder when the event isn't a round robin (the endpoint
 * 404s — we treat that as "no table available" rather than an error
 * the user has to see).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { useTheme } from '../../providers/ThemeProvider';
import { spacing, fontSize, fontWeight, radius } from '../../theme/spacing';
import { getEventStandings, type StandingsRow } from '../../api/v2';

interface StandingsTableProps {
  eventId: number;
  highlightRegistrationIds?: number[];
}

export const StandingsTable: React.FC<StandingsTableProps> = ({
  eventId,
  highlightRegistrationIds = [],
}) => {
  const { colors } = useTheme();
  const [rows, setRows] = useState<StandingsRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await getEventStandings(eventId);
      setRows(data.standings);
    } catch (err: any) {
      if (err?.response?.status === 404) {
        setUnavailable(true);
      } else {
        setRows([]);
      }
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }
  if (unavailable) return null;
  if (!rows || rows.length === 0) {
    return (
      <View style={[styles.empty, { borderColor: colors.cardBorder }]}>
        <Text style={[styles.emptyText, { color: colors.textTertiary }]}>
          Tabelle erscheint, sobald das erste Spiel beendet ist.
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.table, { backgroundColor: colors.surface, borderColor: colors.cardBorder }]}>
      <View style={[styles.headerRow, { borderBottomColor: colors.cardBorder }]}>
        <Text style={[styles.colRank, styles.headerCell, { color: colors.textTertiary }]}>#</Text>
        <Text style={[styles.colName, styles.headerCell, { color: colors.textTertiary }]}>Team</Text>
        <Text style={[styles.colStat, styles.headerCell, { color: colors.textTertiary }]}>Sp</Text>
        <Text style={[styles.colStat, styles.headerCell, { color: colors.textTertiary }]}>S–N</Text>
        <Text style={[styles.colStat, styles.headerCell, { color: colors.textTertiary }]}>±</Text>
        <Text style={[styles.colPoints, styles.headerCell, { color: colors.textTertiary }]}>Pkt</Text>
      </View>
      {rows.map((row) => {
        const isMine = highlightRegistrationIds.includes(row.registration_id);
        return (
          <View
            key={row.registration_id}
            style={[
              styles.row,
              {
                borderBottomColor: colors.cardBorder,
                backgroundColor: isMine ? colors.primary + '14' : 'transparent',
              },
            ]}
          >
            <Text style={[styles.colRank, { color: colors.textPrimary }]}>{row.rank}</Text>
            <Text
              style={[
                styles.colName,
                {
                  color: colors.textPrimary,
                  fontWeight: isMine ? '800' : (fontWeight.semibold as any),
                },
              ]}
              numberOfLines={1}
            >
              {row.name}
            </Text>
            <Text style={[styles.colStat, { color: colors.textSecondary }]}>{row.played}</Text>
            <Text style={[styles.colStat, { color: colors.textSecondary }]}>
              {row.wins}–{row.losses}
            </Text>
            <Text
              style={[
                styles.colStat,
                { color: row.set_diff > 0 ? colors.success : row.set_diff < 0 ? colors.error : colors.textSecondary },
              ]}
            >
              {row.set_diff > 0 ? '+' : ''}
              {row.set_diff}
            </Text>
            <Text style={[styles.colPoints, { color: colors.primary }]}>{row.points}</Text>
          </View>
        );
      })}
    </View>
  );
};

const styles = StyleSheet.create({
  center: { paddingVertical: spacing.lg, alignItems: 'center' },
  empty: {
    padding: spacing.lg,
    borderWidth: 1,
    borderRadius: radius.lg,
    alignItems: 'center',
  },
  emptyText: { fontSize: fontSize.sm, textAlign: 'center' },
  table: {
    borderWidth: 1,
    borderRadius: radius.lg,
    overflow: 'hidden',
  },
  headerRow: {
    flexDirection: 'row',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
  },
  headerCell: {
    fontSize: fontSize.xxs,
    fontWeight: fontWeight.bold as any,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  row: {
    flexDirection: 'row',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    alignItems: 'center',
  },
  colRank: { width: 28, fontSize: fontSize.sm },
  colName: { flex: 1, fontSize: fontSize.sm, paddingRight: spacing.sm },
  colStat: { width: 36, fontSize: fontSize.sm, textAlign: 'right' },
  colPoints: { width: 44, fontSize: fontSize.base, fontWeight: '800' as any, textAlign: 'right' },
});
