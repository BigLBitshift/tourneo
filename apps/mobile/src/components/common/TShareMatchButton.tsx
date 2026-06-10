/**
 * TShareMatchButton — primary touch target on the match-result/recap UI.
 *
 * Tapping fetches the server-rendered match card and opens the
 * ShareCardSheet (image preview → "Als Bild teilen" für Stories, oder
 * klassisches Text-Sharing). Falls back to a quiet info toast when the
 * match has no card yet (still in progress).
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
import { getMatchCard, type MatchCard } from '../../api/v2';
import { ShareCardSheet } from '../share/ShareCardSheet';
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
  const [card, setCard] = useState<MatchCard | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const onPress = async () => {
    if (busy) return;
    setBusy(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    try {
      const data = await getMatchCard(matchId);
      setCard(data);
      setSheetOpen(true);
    } catch (err: any) {
      if (err?.response?.status === 400 || err?.response?.status === 404) {
        showToast('info', 'Noch keine Match-Karte', 'Das Match ist noch nicht abgeschlossen.');
      } else {
        showToast('error', 'Teilen fehlgeschlagen');
      }
    } finally {
      setBusy(false);
    }
  };

  const isPrimary = variant === 'primary';
  const bg = isPrimary ? colors.primary : 'transparent';
  const textColor = isPrimary ? '#FFF' : colors.primary;
  const borderColor = isPrimary ? colors.primary : colors.cardBorder;

  return (
    <>
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

      <ShareCardSheet visible={sheetOpen} card={card} onClose={() => setSheetOpen(false)} />
    </>
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
