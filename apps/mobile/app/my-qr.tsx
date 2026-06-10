/**
 * MyQrScreen — the user's profile as a QR code for instant networking
 * at the court. Scanning opens the public web profile, which deep-links
 * into the app when installed (landing pages handle the fallback).
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Stack } from 'expo-router';
import QRCode from 'react-native-qrcode-svg';
import { useTheme } from '../src/providers/ThemeProvider';
import { spacing, fontSize, fontWeight, radius } from '../src/theme/spacing';
import { useAuthStore } from '../src/store/authStore';
import { deepLinks } from '../src/utils/deepLinks';

export default function MyQrScreen() {
  const { colors } = useTheme();
  const { user } = useAuthStore();

  if (!user) return null;
  const url = deepLinks.profile(user.id);
  const name = user.display_name || `${user.first_name} ${user.last_name}`;

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <Stack.Screen options={{ title: 'Mein QR-Code', headerShown: true }} />
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.cardBorder }]}>
        <Text style={[styles.name, { color: colors.textPrimary }]}>{name}</Text>
        <View style={styles.qrWrap}>
          <QRCode value={url} size={220} backgroundColor="#FFFFFF" color="#0A0A14" />
        </View>
        <Text style={[styles.hint, { color: colors.textTertiary }]}>
          Scannen öffnet dein Profil — vernetze dich direkt am Court.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  card: {
    padding: spacing.xl,
    borderRadius: radius.lg,
    borderWidth: 1,
    alignItems: 'center',
    gap: spacing.lg,
    width: '100%',
    maxWidth: 340,
  },
  name: { fontSize: fontSize.lg, fontWeight: fontWeight.bold as any },
  qrWrap: { padding: spacing.md, backgroundColor: '#FFFFFF', borderRadius: radius.md },
  hint: { fontSize: fontSize.xs, textAlign: 'center' },
});
