/**
 * ShareCardSheet — modal that previews the MatchShareCard and offers
 * "Als Bild teilen" (view-shot → PNG → expo-sharing) and "Als Text
 * teilen" (classic share sheet).
 *
 * Capture strategy: the card is rendered visibly inside the modal (the
 * preview IS the capture target), so there's no hidden off-screen view
 * that could be clipped on Android.
 */
import React, { useRef, useState } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import ViewShot, { type ViewShotRef } from 'react-native-view-shot';
import * as Sharing from 'expo-sharing';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { MatchShareCard, SHARE_CARD_WIDTH } from './MatchShareCard';
import type { MatchCard } from '../../api/v2';
import { shareMatchById } from '../../utils/shareMatch';
import { useToast } from '../common/TToast';

interface ShareCardSheetProps {
  visible: boolean;
  card: MatchCard | null;
  onClose: () => void;
}

export const ShareCardSheet: React.FC<ShareCardSheetProps> = ({ visible, card, onClose }) => {
  const shotRef = useRef<ViewShotRef>(null);
  const [busy, setBusy] = useState<'image' | 'text' | null>(null);
  const showToast = useToast((s) => s.show);

  const shareAsImage = async () => {
    if (!shotRef.current?.capture || busy) return;
    setBusy('image');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    try {
      const uri = await shotRef.current.capture();
      const canShare = await Sharing.isAvailableAsync();
      if (!canShare) {
        showToast('error', 'Teilen nicht verfügbar', 'Auf diesem Gerät ist kein Share-Sheet verfügbar.');
        return;
      }
      await Sharing.shareAsync(uri, {
        mimeType: 'image/png',
        dialogTitle: 'Match teilen',
      });
      onClose();
    } catch {
      showToast('error', 'Bild konnte nicht erstellt werden');
    } finally {
      setBusy(null);
    }
  };

  const shareAsText = async () => {
    if (!card || busy) return;
    setBusy('text');
    try {
      await shareMatchById(card.match_id);
      onClose();
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.handleRow}>
            <View style={styles.handle} />
            <TouchableOpacity onPress={onClose} style={styles.closeBtn} hitSlop={12}>
              <Ionicons name="close" size={22} color="rgba(255,255,255,0.7)" />
            </TouchableOpacity>
          </View>

          <ScrollView
            contentContainerStyle={styles.previewWrap}
            showsVerticalScrollIndicator={false}
          >
            {card ? (
              <ViewShot
                ref={shotRef}
                options={{ format: 'png', quality: 1, result: 'tmpfile' }}
                style={styles.shot}
              >
                <MatchShareCard card={card} />
              </ViewShot>
            ) : (
              <ActivityIndicator color="#8B9DFF" style={{ marginVertical: 120 }} />
            )}
          </ScrollView>

          <View style={styles.actions}>
            <TouchableOpacity
              style={[styles.actionBtn, styles.primaryBtn]}
              onPress={shareAsImage}
              disabled={!card || !!busy}
            >
              {busy === 'image' ? (
                <ActivityIndicator color="#FFF" />
              ) : (
                <>
                  <Ionicons name="image-outline" size={18} color="#FFF" />
                  <Text style={styles.primaryText}>Als Bild teilen</Text>
                </>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionBtn, styles.ghostBtn]}
              onPress={shareAsText}
              disabled={!card || !!busy}
            >
              {busy === 'text' ? (
                <ActivityIndicator color="#8B9DFF" />
              ) : (
                <>
                  <Ionicons name="text-outline" size={18} color="#8B9DFF" />
                  <Text style={styles.ghostText}>Als Text teilen</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#11111C',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingBottom: 34,
    maxHeight: '92%',
  },
  handleRow: { alignItems: 'center', paddingTop: 10, paddingBottom: 4 },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.25)',
  },
  closeBtn: { position: 'absolute', right: 16, top: 10 },
  previewWrap: { alignItems: 'center', paddingVertical: 16 },
  shot: { width: SHARE_CARD_WIDTH },
  actions: { flexDirection: 'row', gap: 10, paddingHorizontal: 20 },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minHeight: 50,
    borderRadius: 14,
  },
  primaryBtn: { backgroundColor: '#4B5FFF' },
  primaryText: { color: '#FFF', fontSize: 15, fontWeight: '700' },
  ghostBtn: { borderWidth: 1, borderColor: 'rgba(139,157,255,0.4)' },
  ghostText: { color: '#8B9DFF', fontSize: 15, fontWeight: '700' },
});
