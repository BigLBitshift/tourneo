import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Alert,
  TouchableOpacity,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../../src/providers/ThemeProvider';
import {
  TButton, TCard, THeader, TInput, TChip, TDivider, TLoadingScreen,
} from '../../../src/components/common';
import { useEventStore } from '../../../src/store/eventStore';
import { MEMBERSHIPS_PURCHASABLE } from '../../../src/config/features';
import { useRegistrationStore } from '../../../src/store/registrationStore';
import { useMembershipStore } from '../../../src/store/membershipStore';
import { spacing, fontSize, fontWeight, radius } from '../../../src/theme/spacing';
import { getMyPlaytomic, type PlaytomicStatus } from '../../../src/api/v2';

type RegType = 'solo' | 'duo' | 'team';

export default function EventRegisterScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const { currentEvent, fetchEventById } = useEventStore();
  const { registerForEvent, loading } = useRegistrationStore();
  const { currentMembership } = useMembershipStore();

  const [regType, setRegType] = useState<RegType>('solo');
  const [partnerEmail, setPartnerEmail] = useState('');
  const [teamName, setTeamName] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [playtomic, setPlaytomic] = useState<PlaytomicStatus | null>(null);

  useEffect(() => {
    if (id) fetchEventById(Number(id));
  }, [id]);

  useEffect(() => {
    getMyPlaytomic().then(setPlaytomic).catch(() => setPlaytomic(null));
  }, []);

  if (!currentEvent) return <TLoadingScreen message="Wird geladen..." />;

  const e = currentEvent;

  // Playtomic gate — require verification for padel tournaments
  const needsPlaytomicGate =
    e.sport_category === 'padel' &&
    playtomic !== null &&
    playtomic.status !== 'approved';

  if (needsPlaytomicGate) {
    const isPending = playtomic.status === 'pending';
    const isRejected = playtomic.status === 'rejected';
    return (
      <View style={[gateStyles.container, { backgroundColor: colors.bg }]}>
        <THeader title="Anmeldung" showBack onBack={() => router.back()} />
        <ScrollView contentContainerStyle={gateStyles.content}>
          <View style={gateStyles.iconWrap}>
            <Ionicons
              name={isPending ? 'hourglass-outline' : isRejected ? 'close-circle-outline' : 'shield-outline'}
              size={64}
              color={isPending ? colors.warning : isRejected ? colors.error : colors.primary}
            />
          </View>
          <Text style={[gateStyles.title, { color: colors.textPrimary }]}>
            {isPending
              ? 'Verifizierung läuft'
              : isRejected
              ? 'Verifizierung abgelehnt'
              : 'Playtomic-Verifizierung nötig'}
          </Text>
          <Text style={[gateStyles.message, { color: colors.textSecondary }]}>
            {isPending
              ? 'Dein Screenshot wird gerade von unseren Admins geprüft. Das dauert meist unter 24 h. Wir benachrichtigen dich, sobald es fertig ist.'
              : isRejected
              ? 'Der eingereichte Screenshot konnte nicht verifiziert werden. Bitte reiche einen neuen, klareren Screenshot ein.'
              : 'Um faire Matches zu gewährleisten, müssen wir dein Playtomic-Level verifizieren, bevor du dich für Padel-Turniere anmelden kannst.'}
          </Text>

          {!isPending && (
            <TouchableOpacity
              onPress={() => router.push('/onboarding/playtomic')}
              style={[gateStyles.primaryBtn, { backgroundColor: colors.primary }]}
            >
              <Text style={gateStyles.primaryBtnText}>
                {isRejected ? 'Neu einreichen' : 'Jetzt verifizieren'}
              </Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity onPress={() => router.back()} style={gateStyles.secondaryBtn}>
            <Text style={[gateStyles.secondaryBtnText, { color: colors.textTertiary }]}>
              Zurück
            </Text>
          </TouchableOpacity>
        </ScrollView>
      </View>
    );
  }
  const feeAmount = (e.entry_fee_cents ?? 0) / 100;
  const discount = currentMembership?.tier === 'club' ? 20 : currentMembership?.tier === 'plus' ? 10 : 0;
  const finalFee = feeAmount * (1 - discount / 100);
  const spotsLeft = e.spots_remaining ?? ((e.max_participants ?? 0) - (e.participant_count ?? 0));
  const isFull = spotsLeft <= 0;

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};
    if (regType === 'duo' && !partnerEmail.trim()) {
      newErrors.partner = 'Partner E-Mail ist erforderlich';
    } else if (regType === 'duo' && !/\S+@\S+\.\S+/.test(partnerEmail)) {
      newErrors.partner = 'Ungültige E-Mail-Adresse';
    }
    if (regType === 'team' && !teamName.trim()) {
      newErrors.team = 'Teamname ist erforderlich';
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleRegister = async () => {
    if (!validate()) return;

    const confirmMessage = isFull
      ? `Du wirst auf die Warteliste gesetzt. ${finalFee > 0 ? `Erst bei Nachrücken wird die Gebühr von ${finalFee.toFixed(2)} € fällig.` : ''}`
      : `Gebühr: ${finalFee > 0 ? `${finalFee.toFixed(2)} €` : 'Kostenlos'}${discount > 0 ? ` (${discount}% Mitglieder-Rabatt)` : ''}`;

    Alert.alert(
      isFull ? 'Auf Warteliste setzen?' : 'Anmeldung bestätigen?',
      confirmMessage,
      [
        { text: 'Abbrechen', style: 'cancel' },
        {
          text: isFull ? 'Ja, auf Warteliste' : 'Jetzt anmelden',
          onPress: async () => {
            try {
              const eventId = Number(id);
              if (!eventId || Number.isNaN(eventId)) {
                Alert.alert('Fehler', 'Ungültige Turnier-ID.');
                return;
              }
              await registerForEvent({
                event_id: String(eventId),
                registration_type: regType,
                partner_user_id: regType === 'duo' ? partnerEmail.trim() : undefined,
                team_id: regType === 'team' ? teamName.trim() : undefined,
              });
              Alert.alert(
                'Erfolg! 🎉',
                isFull
                  ? 'Du bist auf der Warteliste. Wir benachrichtigen dich, wenn ein Platz frei wird.'
                  : 'Du bist für das Turnier angemeldet!',
                [{ text: 'OK', onPress: () => router.back() }]
              );
            } catch (error: any) {
              Alert.alert('Fehler', error.message || 'Anmeldung fehlgeschlagen');
            }
          },
        },
      ]
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.bgSecondary }]}>
      <THeader title="Anmeldung" subtitle={e.title} showBack onBack={() => router.back()} />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* Event Summary */}
        <TCard variant="outlined" style={styles.eventSummary}>
          <Text style={[styles.eventTitle, { color: colors.textPrimary }]}>{e.title}</Text>
          <Text style={[styles.eventMeta, { color: colors.textSecondary }]}>
            📅 {e.start_date}
          </Text>
          <Text style={[styles.eventMeta, { color: colors.textSecondary }]}>
            📍 {e.venue?.name || 'TBD'}{e.venue?.city ? `, ${e.venue.city}` : ''}
          </Text>
        </TCard>

        {/* Registration Type */}
        <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>Anmeldeart</Text>
        <View style={styles.regTypeRow}>
          <TChip label="Einzel" selected={regType === 'solo'} onPress={() => setRegType('solo')} />
          <TChip label="Duo" selected={regType === 'duo'} onPress={() => setRegType('duo')} />
          <TChip label="Team" selected={regType === 'team'} onPress={() => setRegType('team')} />
        </View>

        {regType === 'duo' && (
          <TInput
            label="Partner E-Mail"
            placeholder="partner@email.de"
            value={partnerEmail}
            onChangeText={setPartnerEmail}
            error={errors.partner}
            keyboardType="email-address"
            autoCapitalize="none"
            hint="Dein Partner muss bereits bei Tourneo registriert sein"
          />
        )}

        {regType === 'team' && (
          <TInput
            label="Team auswählen"
            placeholder="Teamname"
            value={teamName}
            onChangeText={setTeamName}
            error={errors.team}
            hint="Wähle ein bestehendes Team oder gib den Namen ein"
          />
        )}

        <TDivider />

        {/* Fee Breakdown */}
        <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>Kostenübersicht</Text>
        <TCard variant="outlined">
          <View style={styles.feeRow}>
            <Text style={[styles.feeLabel, { color: colors.textSecondary }]}>Turniergebühr</Text>
            <Text style={[styles.feeValue, { color: colors.textPrimary }]}>
              {feeAmount.toFixed(2)} €
            </Text>
          </View>
          {discount > 0 && (
            <View style={styles.feeRow}>
              <Text style={[styles.feeLabel, { color: colors.success }]}>
                {currentMembership?.tier === 'club' ? 'Club' : 'Plus'}-Rabatt ({discount}%)
              </Text>
              <Text style={[styles.feeValue, { color: colors.success }]}>
                -{(feeAmount * discount / 100).toFixed(2)} €
              </Text>
            </View>
          )}
          <TDivider marginVertical={spacing.sm} />
          <View style={styles.feeRow}>
            <Text style={[styles.feeTotalLabel, { color: colors.textPrimary }]}>Gesamt</Text>
            <Text style={[styles.feeTotalValue, { color: (colors.primary as string) }]}>
              {finalFee.toFixed(2)} €
            </Text>
          </View>
        </TCard>

        {MEMBERSHIPS_PURCHASABLE && discount === 0 && (
          <TCard variant="outlined" style={StyleSheet.flatten([styles.upsellCard, { borderColor: colors.membership.plus }])}>
            <Text style={[styles.upsellText, { color: colors.textSecondary }]}>
              💡 Mit Plus (7,99€/Mo) sparst du 10% auf Turniergebühren!
            </Text>
            <TButton
              title="Mitgliedschaft anzeigen"
              onPress={() => router.push('/membership')}
              variant="ghost"
              size="sm"
              fullWidth={false}
            />
          </TCard>
        )}

        {isFull && (
          <TCard variant="outlined" style={StyleSheet.flatten([styles.waitlistCard, { borderColor: colors.warning }])}>
            <Text style={styles.waitlistIcon}>⏳</Text>
            <Text style={[styles.waitlistTitle, { color: colors.textPrimary }]}>
              Turnier ist voll
            </Text>
            <Text style={[styles.waitlistText, { color: colors.textSecondary }]}>
              Du wirst auf die Warteliste gesetzt. Bei Club/Plus-Mitgliedschaft hast du Priorität beim Nachrücken.
            </Text>
          </TCard>
        )}

        {/* Cancellation Info */}
        <Text style={[styles.policyText, { color: colors.textTertiary }]}>
          Mit der Anmeldung akzeptierst du die Stornierungsrichtlinie: 75% Erstattung bei Stornierung 14+ Tage vor dem Event, keine Erstattung danach.
        </Text>

        <TButton
          title={isFull ? 'Auf Warteliste setzen' : `Jetzt anmelden · ${finalFee.toFixed(2)} €`}
          onPress={handleRegister}
          loading={loading}
          size="lg"
          style={{ marginTop: spacing.md }}
        />

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: spacing.md },
  eventSummary: { marginBottom: spacing.lg },
  eventTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.bold as any, marginBottom: spacing.xs },
  eventMeta: { fontSize: fontSize.sm, marginBottom: 3 },
  sectionTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.semibold as any, marginBottom: spacing.sm },
  regTypeRow: { flexDirection: 'row', marginBottom: spacing.md },
  feeRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.xs },
  feeLabel: { fontSize: fontSize.md },
  feeValue: { fontSize: fontSize.md, fontWeight: fontWeight.medium as any },
  feeTotalLabel: { fontSize: fontSize.lg, fontWeight: fontWeight.bold as any },
  feeTotalValue: { fontSize: fontSize.lg, fontWeight: fontWeight.bold as any },
  upsellCard: { marginTop: spacing.md, borderWidth: 1, alignItems: 'center' },
  upsellText: { fontSize: fontSize.sm, textAlign: 'center', marginBottom: spacing.sm },
  waitlistCard: { marginTop: spacing.md, borderWidth: 1, alignItems: 'center' },
  waitlistIcon: { fontSize: 32, marginBottom: spacing.xs },
  waitlistTitle: { fontSize: fontSize.md, fontWeight: fontWeight.semibold as any, marginBottom: spacing.xs },
  waitlistText: { fontSize: fontSize.sm, textAlign: 'center', lineHeight: 20 },
  policyText: { fontSize: fontSize.xs, textAlign: 'center', lineHeight: 18, marginTop: spacing.lg },
});

const gateStyles = StyleSheet.create({
  container: { flex: 1 },
  content: {
    padding: spacing.lg,
    alignItems: 'center',
    paddingTop: spacing['5xl'],
  },
  iconWrap: {
    marginBottom: spacing.lg,
  },
  title: {
    fontSize: fontSize.xxl,
    fontWeight: fontWeight.bold as any,
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  message: {
    fontSize: fontSize.sm,
    lineHeight: 21,
    textAlign: 'center',
    marginBottom: spacing.xl,
    paddingHorizontal: spacing.md,
  },
  primaryBtn: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.md,
    minWidth: 220,
    alignItems: 'center',
  },
  primaryBtnText: {
    color: '#FFF',
    fontSize: fontSize.base,
    fontWeight: fontWeight.bold as any,
  },
  secondaryBtn: {
    padding: spacing.md,
    marginTop: spacing.sm,
  },
  secondaryBtnText: {
    fontSize: fontSize.sm,
  },
});