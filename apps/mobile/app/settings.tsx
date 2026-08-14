/**
 * Settings Screen – Tourneo
 * Sections: Profile, Biometric Login, Notifications, Consent Management,
 *           Legal Pages, Account, Danger Zone
 */
import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView, Alert, Switch, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../src/providers/ThemeProvider';
import { THeader, TListItem, TCard, TButton, TDivider, TInput, TAvatar } from '../src/components/common';
import { useAuthStore } from '../src/store/authStore';
import { useBiometricStore } from '../src/store/biometricStore';
import { useBiometrics } from '../src/hooks/useBiometrics';
import { useConsentStore } from '../src/store/consentStore';
import { spacing, fontSize, fontWeight } from '../src/theme/spacing';
import * as SecureStore from 'expo-secure-store';
import api from '../src/api/client';

export default function SettingsScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { user, logout, updateUser } = useAuthStore();

  // Biometrics
  const { isAvailable: biometricsAvailable, biometricType, getDisplayName } = useBiometrics();
  const { enabled: biometricEnabled, enable: enableBiometric, disable: disableBiometric } = useBiometricStore();

  // Consent
  const { consentData: consent, initialize: loadConsent, updateOptionalConsent, withdrawAllConsent, requestDataExport, requestDataDeletion } = useConsentStore();

  // Profile edit
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState(user?.display_name || '');
  const [loading, setLoading] = useState(false);

  // Notification toggle (local)
  const [pushEnabled, setPushEnabled] = useState(consent?.pushNotifications ?? true);

  useEffect(() => {
    loadConsent();
  }, []);

  useEffect(() => {
    setPushEnabled(consent?.pushNotifications ?? true);
  }, [consent]);

  /* ── Profile Save ─────────────────────────────────────────── */
  const handleSaveProfile = async () => {
    if (!displayName.trim() || displayName.trim().length < 3) {
      Alert.alert(t('common.error'), t('settings.displayNameMinLength'));
      return;
    }
    setLoading(true);
    try {
      await api.put('/users/profile', { display_name: displayName.trim() });
      updateUser({ display_name: displayName.trim() });
      setEditing(false);
      Alert.alert(t('common.success'), t('settings.profileUpdated'));
    } catch (error: unknown) {
      const msg = (error as any)?.response?.data?.message || t('settings.profileUpdateFailed');
      Alert.alert(t('common.error'), msg);
    } finally {
      setLoading(false);
    }
  };

  /* ── Biometric Toggle ─────────────────────────────────────── */
  const handleBiometricToggle = async (value: boolean) => {
    if (value) {
      // Get current access token to store for biometric re-auth
      const token = await SecureStore.getItemAsync('access_token');
      if (token) {
        await enableBiometric(token);
      }
    } else {
      await disableBiometric();
    }
  };

  /* ── Consent Toggles ──────────────────────────────────────── */
  const handleConsentToggle = async (key: 'pushNotifications' | 'personalization' | 'newsletter', value: boolean) => {
    await updateOptionalConsent(key, value);
    if (key === 'pushNotifications') setPushEnabled(value);
  };

  /* ── Withdraw All Consent ─────────────────────────────────── */
  const handleWithdrawConsent = () => {
    Alert.alert(
      t('settings.withdrawConsentTitle'),
      t('settings.withdrawConsentMessage'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('settings.withdrawConsentConfirm'),
          style: 'destructive',
          onPress: async () => {
            await withdrawAllConsent();
            await logout();
            router.replace('/(auth)/login');
          },
        },
      ]
    );
  };

  /* ── Data Export ───────────────────────────────────────────── */
  const handleDataExport = async () => {
    try {
      await requestDataExport();
      Alert.alert(t('settings.dataExportTitle'), t('settings.dataExportMessage'));
    } catch {
      Alert.alert(t('common.error'), t('settings.dataExportFailed'));
    }
  };

  /* ── Data Deletion ────────────────────────────────────────── */
  const handleDataDeletion = () => {
    Alert.alert(
      t('settings.dataDeletionTitle'),
      t('settings.dataDeletionMessage'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('settings.dataDeletionConfirm'),
          style: 'destructive',
          onPress: async () => {
            try {
              await requestDataDeletion();
              Alert.alert(t('settings.dataDeletionSuccess'));
            } catch {
              Alert.alert(t('common.error'), t('settings.dataDeletionFailed'));
            }
          },
        },
      ]
    );
  };

  /* ── Delete Account ───────────────────────────────────────── */
  const handleDeleteAccount = () => {
    Alert.alert(
      t('settings.deleteAccountTitle'),
      t('settings.deleteAccountMessage'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('settings.deleteAccountConfirm'),
          style: 'destructive',
          onPress: () => {
            Alert.alert(
              t('settings.deleteAccountFinalTitle'),
              t('settings.deleteAccountFinalMessage'),
              [
                { text: t('common.cancel'), style: 'cancel' },
                {
                  text: t('settings.deleteAccountFinalConfirm'),
                  style: 'destructive',
                  onPress: async () => {
                    try {
                      await api.post('/me/delete-account');
                      await logout();
                      router.replace('/(auth)/onboarding');
                    } catch {
                      Alert.alert(t('common.error'), t('settings.deleteAccountFailed'));
                    }
                  },
                },
              ]
            );
          },
        },
      ]
    );
  };

  if (!user) {
    router.replace('/(auth)/login');
    return null;
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.bgTertiary }]}>
      <THeader title={t('settings.title')} showBack onBack={() => router.back()} />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>

        {/* ── Profile Section ──────────────────────────────────── */}
        <TCard variant="default" style={styles.section}>
          <View style={styles.profileHeader}>
            <TAvatar uri={user.avatar_url} name={user.display_name} size="lg" />
            <View style={styles.profileInfo}>
              <Text style={[styles.profileName, { color: colors.textPrimary }]}>{user.display_name}</Text>
              <Text style={[styles.profileEmail, { color: colors.textTertiary }]}>{user.email}</Text>
            </View>
          </View>

          {editing ? (
            <View style={styles.editForm}>
              <TInput
                label={t('settings.displayName')}
                value={displayName}
                onChangeText={setDisplayName}
              />
              <View style={styles.editButtons}>
                <TButton
                  title={t('common.save')}
                  onPress={handleSaveProfile}
                  loading={loading}
                  size="sm"
                  fullWidth={false}
                  style={{ flex: 1, marginRight: spacing.sm }}
                />
                <TButton
                  title={t('common.cancel')}
                  onPress={() => { setEditing(false); setDisplayName(user.display_name || ''); }}
                  variant="outline"
                  size="sm"
                  fullWidth={false}
                  style={{ flex: 1 }}
                />
              </View>
            </View>
          ) : (
            <TButton
              title={t('settings.editProfile')}
              onPress={() => setEditing(true)}
              variant="outline"
              size="sm"
              style={{ marginTop: spacing.md }}
            />
          )}
        </TCard>

        {/* ── Biometric Login ─────────────────────────────────── */}
        {biometricsAvailable && (
          <TCard variant="default" style={styles.section}>
            <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>
              {t('settings.security')}
            </Text>
            <View style={styles.switchRow}>
              <View style={styles.switchInfo}>
                <Ionicons
                  name={biometricType === 'faceId' ? 'scan-outline' : 'finger-print-outline'}
                  size={22}
                  color={colors.primary as string}
                  style={{ marginRight: spacing.sm }}
                />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.switchLabel, { color: colors.textPrimary }]}>
                    {getDisplayName()}
                  </Text>
                  <Text style={[styles.switchHint, { color: colors.textTertiary }]}>
                    {t('settings.biometricHint')}
                  </Text>
                </View>
              </View>
              <Switch
                value={biometricEnabled}
                onValueChange={handleBiometricToggle}
                trackColor={{ false: colors.border, true: colors.primary as string }}
                thumbColor={biometricEnabled ? '#fff' : colors.bgTertiary}
              />
            </View>
          </TCard>
        )}

        {/* ── Notifications ───────────────────────────────────── */}
        <TCard variant="default" style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>
            {t('settings.notifications')}
          </Text>
          <View style={styles.switchRow}>
            <View style={styles.switchInfo}>
              <Ionicons name="notifications-outline" size={22} color={colors.primary as string} style={{ marginRight: spacing.sm }} />
              <Text style={[styles.switchLabel, { color: colors.textPrimary }]}>{t('settings.pushNotifications')}</Text>
            </View>
            <Switch
              value={pushEnabled}
              onValueChange={(v) => handleConsentToggle('pushNotifications', v)}
              trackColor={{ false: colors.border, true: colors.primary as string }}
              thumbColor={pushEnabled ? '#fff' : colors.bgTertiary}
            />
          </View>
        </TCard>

        {/* ── Consent / DSGVO Management ─────────────────────── */}
        <TCard variant="default" style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>
            {t('settings.privacy')}
          </Text>
          <View style={styles.switchRow}>
            <View style={styles.switchInfo}>
              <Ionicons name="person-circle-outline" size={22} color={colors.primary as string} style={{ marginRight: spacing.sm }} />
              <Text style={[styles.switchLabel, { color: colors.textPrimary }]}>{t('settings.personalization')}</Text>
            </View>
            <Switch
              value={consent?.personalization ?? false}
              onValueChange={(v) => handleConsentToggle('personalization', v)}
              trackColor={{ false: colors.border, true: colors.primary as string }}
              thumbColor={consent?.personalization ? '#fff' : colors.bgTertiary}
            />
          </View>
          <TDivider style={{ marginVertical: spacing.xs }} />
          <View style={styles.switchRow}>
            <View style={styles.switchInfo}>
              <Ionicons name="mail-outline" size={22} color={colors.primary as string} style={{ marginRight: spacing.sm }} />
              <Text style={[styles.switchLabel, { color: colors.textPrimary }]}>{t('settings.newsletter')}</Text>
            </View>
            <Switch
              value={consent?.newsletter ?? false}
              onValueChange={(v) => handleConsentToggle('newsletter', v)}
              trackColor={{ false: colors.border, true: colors.primary as string }}
              thumbColor={consent?.newsletter ? '#fff' : colors.bgTertiary}
            />
          </View>
          <TDivider style={{ marginVertical: spacing.sm }} />
          <TListItem
            title={t('settings.exportData')}
            leftIcon={<Ionicons name="download-outline" size={20} color={colors.textSecondary as string} />}
            onPress={handleDataExport}
          />
          <TListItem
            title={t('settings.requestDeletion')}
            leftIcon={<Ionicons name="trash-outline" size={20} color={colors.error as string} />}
            onPress={handleDataDeletion}
          />
          <TDivider style={{ marginVertical: spacing.xs }} />
          <TButton
            title={t('settings.withdrawAllConsent')}
            onPress={handleWithdrawConsent}
            variant="outline"
            size="sm"
            style={{ marginTop: spacing.sm }}
          />
          {consent?.consentDate && (
            <Text style={[styles.consentDate, { color: colors.textTertiary }]}>
              {t('settings.consentedOn')}: {new Date(consent.consentDate).toLocaleDateString('de-DE')}
            </Text>
          )}
        </TCard>

        {/* ── Legal Links ─────────────────────────────────────── */}
        <TCard variant="default" style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>
            {t('settings.legal')}
          </Text>
          <TListItem
            title={t('legal.agb')}
            leftIcon={<Ionicons name="document-text-outline" size={20} color={colors.textSecondary as string} />}
            onPress={() => router.push('/legal/agb')}
          />
          <TListItem
            title={t('legal.datenschutz')}
            leftIcon={<Ionicons name="shield-checkmark-outline" size={20} color={colors.textSecondary as string} />}
            onPress={() => router.push('/legal/datenschutz')}
          />
          <TListItem
            title={t('legal.impressum')}
            leftIcon={<Ionicons name="information-circle-outline" size={20} color={colors.textSecondary as string} />}
            onPress={() => router.push('/legal/impressum')}
          />
          {/* A block the user cannot undo is a trap rather than a control,
              and App Store review looks for this path specifically. */}
          <TListItem
            title={t('settings.blockedUsers')}
            leftIcon={<Ionicons name="ban-outline" size={20} color={colors.textSecondary as string} />}
            onPress={() => router.push('/blocked-users')}
          />
          {/* The support screen existed but was unreachable from the app. */}
          <TListItem
            title={t('settings.support')}
            leftIcon={<Ionicons name="help-buoy-outline" size={20} color={colors.textSecondary as string} />}
            onPress={() => router.push('/support')}
          />
        </TCard>

        {/* ── Account Actions ─────────────────────────────────── */}
        <TCard variant="default" style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>
            {t('settings.account')}
          </Text>
          <TListItem
            title={t('settings.changePassword')}
            leftIcon={<Ionicons name="key-outline" size={20} color={colors.textSecondary as string} />}
            onPress={() => Alert.alert(t('common.info'), t('settings.changePasswordHint'))}
          />
          <TDivider style={{ marginVertical: spacing.xs }} />
          <TButton
            title={t('settings.logout')}
            onPress={async () => { await logout(); router.replace('/(auth)/login'); }}
            variant="outline"
            size="sm"
            style={{ marginTop: spacing.sm }}
          />
        </TCard>

        {/* ── Danger Zone ─────────────────────────────────────── */}
        <TCard variant="default" style={StyleSheet.flatten([styles.section, { borderColor: colors.error, borderWidth: 1 }])}>
          <Text style={[styles.sectionTitle, { color: colors.error }]}>
            {t('settings.dangerZone')}
          </Text>
          <Text style={[styles.dangerText, { color: colors.textSecondary }]}>
            {t('settings.deleteAccountWarning')}
          </Text>
          <TButton
            title={t('settings.deleteAccount')}
            onPress={handleDeleteAccount}
            variant="danger"
            size="sm"
            style={{ marginTop: spacing.md }}
          />
        </TCard>

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: spacing.md },
  section: { marginBottom: spacing.md },
  profileHeader: { flexDirection: 'row', alignItems: 'center' },
  profileInfo: { marginLeft: spacing.md, flex: 1 },
  profileName: { fontSize: fontSize.lg, fontWeight: fontWeight.bold as any },
  profileEmail: { fontSize: fontSize.sm, marginTop: 2 },
  editForm: { marginTop: spacing.md },
  editButtons: { flexDirection: 'row', marginTop: spacing.sm },
  sectionTitle: { fontSize: fontSize.md, fontWeight: fontWeight.semibold as any, marginBottom: spacing.sm },
  switchRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: spacing.sm },
  switchInfo: { flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: spacing.sm },
  switchLabel: { fontSize: fontSize.md },
  switchHint: { fontSize: fontSize.xs, marginTop: 2 },
  dangerText: { fontSize: fontSize.sm, lineHeight: 20 },
  consentDate: { fontSize: fontSize.xs, marginTop: spacing.sm, textAlign: 'center' },
});