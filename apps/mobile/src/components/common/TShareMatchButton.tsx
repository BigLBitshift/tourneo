/**
 * TShareMatchButton — primary touch target on the match-result/recap UI.
 *
 * Wraps shareMatchById so callers only need to pass the matchId. Falls
 * back to a quiet no-op when the card endpoint says the match isn't
 * ready (still in progress, missing winner) — we don't want to throw an
 * error toast for a perfectly normal case.
 */
import React, { useState } from 'react';
import {
  TouchableOpacity,
  Text,
  StyleSheet,
  ActivityIndicator,
  StyleProp,
  ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useTheme } from '../../providers/ThemeProvider';
import { spacing, fontSize, fontWeight, radius } from '../../theme/spacing';
import { shareMatchById } from '../../utils/shareMatch';
import { useToast } from './TToast';

interface TShareMatchButtonProps {
  matchId: number;
  label?: string;
  variant?: 'primary' | 'ghost';
  style?: StyleProp<ViewStyle>;
}

export const TShareMatchButton: React.FC<TShareMatchButtonProps> = ({
  matchId,
  label = 'Sieg teilen',
  variant = 'primary',
  style,
}) => {
  const { colors } = useTheme();
  const showToast = useToast((s) => s.show);
  const [busy, setBusy] = useState(false);

  const onPress = async () => {
    if (busy) return;
    setBusy(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    try {
      const ok = await shareMatchById(matchId);
      if (!ok) {
        showToast('info', 'Noch keine Match-Karte', 'Das Match ist noch nicht abgeschlossen.');
      }
    } catch {
      showToast('error', 'Teilen fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  };

  const isPrimary = variant === 'primary';
  const bg = isPrimary ? colors.primary : 'transparent';
  const textColor = isPrimary ? '#FFF' : colors.primary;
  const borderColor = isPrimary ? colors.primary : colors.cardBorder;

  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={busy}
      activeOpacity={0.85}
      style={[
        styles.btn,
        {
          backgroundColor: bg,
          borderColor,
          opacity: busy ? 0.7 : 1,
        },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={textColor} />
      ) : (
        <>
          <Ionicons name="share-social-outline" size={18} color={textColor} />
          <Text style={[styles.label, { color: textColor }]}>{label}</Text>
        </>
      )}
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    gap: 8,
    minHeight: 44,
  },
  label: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold as any },
});
