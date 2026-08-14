/**
 * Register Screen – Tourneo
 * Email registration + Apple Sign-In + consent checkboxes
 */
import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  KeyboardAvoidingView, Platform, Alert, Switch,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import * as AppleAuthentication from 'expo-apple-authentication';
import { useTheme } from '../../src/providers/ThemeProvider';
import { TButton, TInput, THeader, TDivider } from '../../src/components/common';
import { useAuthStore } from '../../src/store/authStore';
import api from '../../src/api/client';
import { spacing, fontSize, fontWeight } from '../../src/theme/spacing';

/** Calendar-correct age in full years — no 365.25 approximation. */
function ageInYears(dob: Date, now: Date = new Date()): number {
  let age = now.getFullYear() - dob.getFullYear();
  const monthDiff = now.getMonth() - dob.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < dob.getDate())) age -= 1;
  return age;
}

export default function RegisterScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { register, loginWithApple, isLoading } = useAuthStore();

  const [form, setForm] = useState({
    email: '',
    password: '',
    confirmPassword: '',
    displayName: '',
    firstName: '',
    lastName: '',
    dateOfBirth: '',
  });
  const [consents, setConsents] = useState({
    terms: false,
    privacy: false,
    age18: false,
  });
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  /**
   * The backend ties every consent record to the exact legal document version
   * the user accepted (Art. 7 Abs. 1 DSGVO). Both ids are mandatory in
   * `registerSchema`, so we resolve them before the form can be submitted.
   */
  const [legalVersions, setLegalVersions] = useState<{ terms: number; privacy: number } | null>(null);
  const [legalError, setLegalError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [terms, privacy] = await Promise.all([
          api.get('/legal/terms'),
          api.get('/legal/privacy'),
        ]);
        if (cancelled) return;
        setLegalVersions({ terms: terms.data.data.id, privacy: privacy.data.data.id });
        setLegalError(false);
      } catch {
        if (!cancelled) setLegalError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const updateForm = (key: string, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (errors[key]) {
      setErrors((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  };

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (!form.email.trim()) newErrors.email = t('auth.emailRequired');
    else if (!/\S+@\S+\.\S+/.test(form.email)) newErrors.email = t('auth.emailInvalid');

    if (!form.password) newErrors.password = t('auth.passwordRequired');
    else if (form.password.length < 8) newErrors.password = t('auth.passwordMinLength');

    if (form.password !== form.confirmPassword) newErrors.confirmPassword = t('auth.passwordMismatch');

    if (!form.displayName.trim()) newErrors.displayName = t('auth.displayNameRequired');
    else if (form.displayName.trim().length < 3) newErrors.displayName = t('auth.displayNameMinLength');

    if (!form.firstName.trim()) newErrors.firstName = t('auth.firstNameRequired');
    if (!form.lastName.trim()) newErrors.lastName = t('auth.lastNameRequired');

    if (!form.dateOfBirth.trim()) {
      newErrors.dateOfBirth = t('auth.dobRequired');
    } else {
      const dobRegex = /^\d{2}\.\d{2}\.\d{4}$/;
      if (!dobRegex.test(form.dateOfBirth)) {
        newErrors.dateOfBirth = t('auth.dobFormat');
      } else {
        const parts = form.dateOfBirth.split('.');
        const dob = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
        if (ageInYears(dob) < 18) newErrors.dateOfBirth = t('auth.dobAge18');
      }
    }

    if (!consents.terms) newErrors.terms = t('auth.termsRequired');
    if (!consents.privacy) newErrors.privacy = t('auth.privacyRequired');
    if (!consents.age18) newErrors.age18 = t('auth.ageRequired');

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const convertDateFormat = (dateStr: string): string => {
    const parts = dateStr.split('.');
    if (parts.length === 3) {
      return `${parts[2]}-${parts[1]}-${parts[0]}`;
    }
    return dateStr;
  };

  const handleRegister = async () => {
    if (!validate()) return;
    if (!legalVersions) {
      Alert.alert(t('common.error'), t('auth.legalUnavailable'), [{ text: t('common.ok') }]);
      return;
    }
    try {
      await register({
        email: form.email.trim().toLowerCase(),
        password: form.password,
        display_name: form.displayName.trim(),
        first_name: form.firstName.trim(),
        last_name: form.lastName.trim(),
        date_of_birth: convertDateFormat(form.dateOfBirth),
        consent_terms: true,
        consent_privacy: true,
        consent_age: true,
        terms_version_id: legalVersions.terms,
        privacy_version_id: legalVersions.privacy,
      });
      router.replace('/(auth)/consent');
    } catch (error: unknown) {
      const msg = (error as Error)?.message || t('auth.registerFailed');
      Alert.alert(t('common.error'), msg, [{ text: t('common.ok') }]);
    }
  };

  /* ── Apple Sign-In ─────────────────────────────────────────── */
  const handleAppleSignIn = async () => {
    try {
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });

      if (credential.identityToken) {
        await loginWithApple(credential.identityToken);
        router.replace('/(auth)/consent');
      }
    } catch (error: unknown) {
      const e = error as { code?: string };
      if (e.code !== 'ERR_REQUEST_CANCELED') {
        Alert.alert(t('common.error'), t('auth.appleSignInFailed'));
      }
    }
  };

  const ConsentRow = ({
    label,
    value,
    onToggle,
    error,
    linkText,
    onLinkPress,
  }: {
    label: string;
    value: boolean;
    onToggle: (v: boolean) => void;
    error?: string;
    linkText?: string;
    onLinkPress?: () => void;
  }) => (
    <View style={styles.consentRow}>
      <Switch
        value={value}
        onValueChange={onToggle}
        trackColor={{ false: colors.border, true: colors.primary as string }}
        thumbColor={value ? '#fff' : colors.bgTertiary}
        ios_backgroundColor={colors.border}
      />
      <View style={styles.consentTextContainer}>
        <Text style={[styles.consentLabel, { color: colors.textSecondary }]}>
          {label}
          {linkText && onLinkPress && (
            <Text style={{ color: colors.primary as string }} onPress={onLinkPress}>
              {' '}{linkText}
            </Text>
          )}
        </Text>
        {error && <Text style={[styles.consentError, { color: colors.error }]}>{error}</Text>}
      </View>
    </View>
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.bgSecondary }]}>
      <THeader title={t('auth.register')} showBack onBack={() => router.back()} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={[styles.headline, { color: colors.textPrimary }]}>
            {t('auth.createAccount')}
          </Text>
          <Text style={[styles.subtitle, { color: colors.textTertiary }]}>
            {t('auth.joinCommunity')}
          </Text>

          {/* ── Apple Sign-In ─────────────────────────────────── */}
          {Platform.OS === 'ios' && (
            <>
              <AppleAuthentication.AppleAuthenticationButton
                buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_UP}
                buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
                cornerRadius={12}
                style={styles.appleButton}
                onPress={handleAppleSignIn}
              />
              <View style={styles.dividerRow}>
                <TDivider style={{ flex: 1 }} />
                <Text style={[styles.dividerText, { color: colors.textTertiary }]}>
                  {t('auth.orRegisterWith')}
                </Text>
                <TDivider style={{ flex: 1 }} />
              </View>
            </>
          )}

          {/* ── Email Registration Form ───────────────────────── */}
          <View style={styles.form}>
            <TInput
              label={t('auth.displayName')}
              placeholder={t('auth.displayNamePlaceholder')}
              value={form.displayName}
              onChangeText={(v) => updateForm('displayName', v)}
              error={errors.displayName}
              autoCapitalize="none"
              required
            />
            <View style={styles.row}>
              <View style={styles.halfInput}>
                <TInput
                  label={t('auth.firstName')}
                  placeholder="Max"
                  value={form.firstName}
                  onChangeText={(v) => updateForm('firstName', v)}
                  error={errors.firstName}
                  required
                />
              </View>
              <View style={styles.halfInput}>
                <TInput
                  label={t('auth.lastName')}
                  placeholder="Mustermann"
                  value={form.lastName}
                  onChangeText={(v) => updateForm('lastName', v)}
                  error={errors.lastName}
                  required
                />
              </View>
            </View>
            <TInput
              label={t('auth.email')}
              placeholder={t('auth.emailPlaceholder')}
              value={form.email}
              onChangeText={(v) => updateForm('email', v)}
              error={errors.email}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              required
            />
            <TInput
              label={t('auth.dateOfBirth')}
              placeholder="TT.MM.JJJJ"
              value={form.dateOfBirth}
              onChangeText={(v) => updateForm('dateOfBirth', v)}
              error={errors.dateOfBirth}
              keyboardType="number-pad"
              hint={t('auth.dobAge18Hint')}
              required
            />
            <TInput
              label={t('auth.password')}
              placeholder={t('auth.passwordPlaceholder')}
              value={form.password}
              onChangeText={(v) => updateForm('password', v)}
              error={errors.password}
              secureTextEntry={!showPassword}
              rightIcon={
                <Ionicons
                  name={showPassword ? 'eye-off-outline' : 'eye-outline'}
                  size={20}
                  color={colors.textTertiary as string}
                />
              }
              onRightIconPress={() => setShowPassword(!showPassword)}
              required
            />
            <TInput
              label={t('auth.confirmPassword')}
              placeholder={t('auth.confirmPasswordPlaceholder')}
              value={form.confirmPassword}
              onChangeText={(v) => updateForm('confirmPassword', v)}
              error={errors.confirmPassword}
              secureTextEntry={!showPassword}
              required
            />
          </View>

          {/* ── Consents ──────────────────────────────────────── */}
          <View style={[styles.consentsSection, { borderTopColor: colors.border }]}>
            <Text style={[styles.consentsTitle, { color: colors.textPrimary }]}>
              {t('auth.consentsTitle')}
            </Text>
            <ConsentRow
              label={t('auth.acceptTerms')}
              linkText={t('legal.agb')}
              onLinkPress={() => router.push('/legal/agb')}
              value={consents.terms}
              onToggle={(v) => setConsents((p) => ({ ...p, terms: v }))}
              error={errors.terms}
            />
            <ConsentRow
              label={t('auth.acceptPrivacy')}
              linkText={t('legal.datenschutz')}
              onLinkPress={() => router.push('/legal/datenschutz')}
              value={consents.privacy}
              onToggle={(v) => setConsents((p) => ({ ...p, privacy: v }))}
              error={errors.privacy}
            />
            <ConsentRow
              label={t('auth.confirmAge18')}
              value={consents.age18}
              onToggle={(v) => setConsents((p) => ({ ...p, age18: v }))}
              error={errors.age18}
            />
          </View>

          {legalError && (
            <Text style={[styles.legalError, { color: colors.error }]}>
              {t('auth.legalUnavailable')}
            </Text>
          )}

          <TButton
            title={t('auth.createAccountBtn')}
            onPress={handleRegister}
            loading={isLoading}
            disabled={!legalVersions}
            size="lg"
          />

          <View style={styles.loginLink}>
            <Text style={[styles.loginText, { color: colors.textSecondary }]}>
              {t('auth.alreadyHaveAccount')}{' '}
            </Text>
            <TouchableOpacity onPress={() => router.push('/(auth)/login')}>
              <Text style={[styles.loginLinkText, { color: colors.primary as string }]}>
                {t('auth.loginNow')}
              </Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  content: { padding: spacing.lg, paddingBottom: 60 },
  headline: { fontSize: fontSize.xxl, fontWeight: fontWeight.bold as any, marginBottom: spacing.xs },
  subtitle: { fontSize: fontSize.md, marginBottom: spacing.lg },
  appleButton: { width: '100%', height: 50, marginBottom: spacing.md },
  dividerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.lg, gap: spacing.sm },
  dividerText: { fontSize: fontSize.sm, paddingHorizontal: spacing.sm },
  form: { marginBottom: spacing.md },
  row: { flexDirection: 'row', gap: spacing.sm },
  halfInput: { flex: 1 },
  consentsSection: { borderTopWidth: 1, paddingTop: spacing.md, marginBottom: spacing.lg },
  consentsTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.semibold as any, marginBottom: spacing.md },
  consentRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: spacing.md },
  consentTextContainer: { flex: 1, marginLeft: spacing.sm, paddingTop: 2 },
  consentLabel: { fontSize: fontSize.sm, lineHeight: 20 },
  consentError: { fontSize: fontSize.xs, marginTop: 2 },
  legalError: { fontSize: fontSize.sm, marginBottom: spacing.md, textAlign: 'center' },
  loginLink: { flexDirection: 'row', justifyContent: 'center', marginTop: spacing.xl },
  loginText: { fontSize: fontSize.sm },
  loginLinkText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold as any },
});