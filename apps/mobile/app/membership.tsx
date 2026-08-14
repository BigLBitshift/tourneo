/**
 * Night Court — Membership upgrade screen.
 *
 * Three-segment toggle (Free · Plus · Club) drives a hero card that swaps
 * its gradient, icon, perks list, and CTA based on the selected tier.
 * Submitting kicks off the existing IAP flow (currently mocked with an
 * Alert until the production purchase code lands).
 */
import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  Pressable,
  Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import {
  NCScreen,
  NCCard,
  NCButton,
  NCIcon,
  NC,
  type IconName,
} from '../src/components/nightcourt';
import { fontFamily } from '../src/theme/typography';
import { useAuthStore } from '../src/store/authStore';
import { MEMBERSHIPS_PURCHASABLE } from '../src/config/features';
import { useMembershipStore, type MembershipTier } from '../src/store/membershipStore';

const TIER_ICON: Record<MembershipTier, IconName> = {
  free: 'user',
  plus: 'sparkle',
  club: 'crown',
};

export default function MembershipScreen() {
  const router = useRouter();
  const { user } = useAuthStore();
  const { tiers, currentMembership, fetchTiers, fetchCurrentMembership } = useMembershipStore();
  const [selected, setSelected] = useState<MembershipTier>('plus');

  useEffect(() => {
    void fetchTiers();
    if (user) void fetchCurrentMembership();
  }, [user, fetchTiers, fetchCurrentMembership]);

  // Default the toggle to the user's current tier (if any)
  useEffect(() => {
    if (currentMembership?.tier) setSelected(currentMembership.tier);
  }, [currentMembership]);

  const tier = tiers.find((t) => t.tier === selected) ?? tiers[0];

  const handlePurchase = () => {
    // Unreachable while MEMBERSHIPS_PURCHASABLE is false — the CTA that
    // called this is not rendered. Kept so the paid flow has one place to
    // return to once StoreKit lands.
    if (!MEMBERSHIPS_PURCHASABLE) return;
    if (!user) {
      Alert.alert(
        'Anmeldung erforderlich',
        'Bitte melde dich an, um ein Abo abzuschließen.',
        [
          { text: 'Abbrechen', style: 'cancel' },
          { text: 'Anmelden', onPress: () => router.push('/(auth)/login') },
        ]
      );
      return;
    }
    if (selected === 'free') return;
  };

  return (
    <NCScreen>
      <ScrollView
        contentContainerStyle={{ paddingBottom: 130 }}
        showsVerticalScrollIndicator={false}
      >
        <View style={s.topBar}>
          <Pressable
            onPress={() => router.back()}
            style={s.glassBtn}
            accessibilityLabel="Zurück"
          >
            <NCIcon name="chevronL" size={20} color={NC.textP} />
          </Pressable>
          <Text style={s.title}>Mitgliedschaft</Text>
          <View style={{ width: 40 }} />
        </View>

        {/* Tier toggle */}
        <View style={{ paddingHorizontal: 20, paddingTop: 12 }}>
          <View style={s.toggle}>
            {(['free', 'plus', 'club'] as MembershipTier[]).map((t) => {
              const active = selected === t;
              const isClub = t === 'club';
              const isPlus = t === 'plus';
              return (
                <Pressable
                  key={t}
                  onPress={() => setSelected(t)}
                  style={[
                    s.toggleBtn,
                    active && {
                      backgroundColor: isClub
                        ? 'transparent'
                        : isPlus
                        ? 'transparent'
                        : NC.bgHover,
                    },
                  ]}
                >
                  {active && (isClub || isPlus) ? (
                    <LinearGradient
                      colors={isClub ? [NC.gold, '#B45309'] : [NC.primary, NC.primaryDark]}
                      start={{ x: 0, y: 0 }}
                      end={{ x: 1, y: 1 }}
                      style={StyleSheet.absoluteFill}
                    />
                  ) : null}
                  <Text
                    style={[
                      s.toggleText,
                      { color: active ? '#FFFFFF' : NC.textS },
                    ]}
                  >
                    {t === 'free' ? 'Free' : t === 'plus' ? 'Plus' : 'Club'}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* Hero card */}
        <View style={{ paddingHorizontal: 20, paddingTop: 16 }}>
          <NCCard
            padded={false}
            style={{
              borderColor:
                selected === 'club'
                  ? 'rgba(245,158,11,0.3)'
                  : selected === 'plus'
                  ? 'rgba(99,102,241,0.3)'
                  : NC.border,
              overflow: 'hidden',
            }}
          >
            <LinearGradient
              colors={
                selected === 'club'
                  ? ['rgba(245,158,11,0.25)', NC.bgCard]
                  : selected === 'plus'
                  ? ['rgba(99,102,241,0.25)', NC.bgCard]
                  : [NC.bgCard, NC.bgCard]
              }
              start={{ x: 0.5, y: 0 }}
              end={{ x: 0.5, y: 1 }}
              style={{ padding: 22, alignItems: 'center' }}
            >
              <View
                style={[
                  s.tierIcon,
                  selected === 'club'
                    ? { backgroundColor: 'transparent' }
                    : selected === 'plus'
                    ? { backgroundColor: 'transparent' }
                    : { backgroundColor: '#444' },
                ]}
              >
                {selected === 'club' || selected === 'plus' ? (
                  <LinearGradient
                    colors={
                      selected === 'club'
                        ? [NC.goldLight, NC.gold]
                        : [NC.primaryLight, NC.primaryDark]
                    }
                    style={StyleSheet.absoluteFill}
                  />
                ) : null}
                <NCIcon
                  name={TIER_ICON[selected]}
                  size={34}
                  color={selected === 'club' ? '#1A120B' : '#FFFFFF'}
                  strokeWidth={2}
                />
              </View>
              <Text style={s.heroName}>Tourneo {capitalize(tier?.name ?? selected)}</Text>
              <Text style={s.heroPrice}>
                {tier && tier.price_monthly > 0
                  ? `${tier.price_monthly.toLocaleString('de', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} € / Monat`
                  : 'Kostenlos'}
              </Text>

              <View style={{ marginTop: 18, alignSelf: 'stretch', gap: 10 }}>
                {(tier?.features ?? []).map((p) => (
                  <View key={p} style={s.perkRow}>
                    <View
                      style={[
                        s.perkCheck,
                        {
                          backgroundColor: selected === 'club' ? NC.goldBg : NC.primaryBg,
                        },
                      ]}
                    >
                      <NCIcon
                        name="check"
                        size={13}
                        color={selected === 'club' ? NC.gold : NC.primaryLight}
                        strokeWidth={2.5}
                      />
                    </View>
                    <Text style={s.perkText}>{p}</Text>
                  </View>
                ))}
              </View>
            </LinearGradient>
          </NCCard>
        </View>

        {/* Comparison */}
        <View style={{ paddingHorizontal: 20, paddingTop: 20 }}>
          <Text style={s.compareTitle}>Vergleich</Text>
          <NCCard padded={false}>
            {COMPARE.map((row, i) => (
              <View
                key={row[0]}
                style={[
                  s.compareRow,
                  i < COMPARE.length - 1 && {
                    borderBottomWidth: 1,
                    borderBottomColor: NC.divider,
                  },
                ]}
              >
                <Text style={s.compareLabel}>{row[0]}</Text>
                <Text style={[s.compareValue, { color: NC.textS }]}>{row[1]}</Text>
                <Text style={[s.compareValue, { color: NC.primaryLight }]}>{row[2]}</Text>
                <Text style={[s.compareValue, { color: NC.gold }]}>{row[3]}</Text>
              </View>
            ))}
          </NCCard>
        </View>

        {/* Legal */}
        <Text style={s.legal}>
          Abos werden über Apple In-App Purchase abgewickelt. Verlängert sich
          automatisch, sofern nicht mindestens 24 Stunden vor Ende der Periode
          gekündigt wird.
        </Text>
      </ScrollView>

      {/* Sticky CTA — only when a purchase can actually complete. An
          advertised price with a button that cannot charge is an App
          Store 2.1 rejection, so the whole footer is absent instead. */}
      {MEMBERSHIPS_PURCHASABLE && selected !== 'free' && (
        <View style={s.footer}>
          <LinearGradient
            colors={['rgba(10,10,20,0)', NC.bg]}
            style={[StyleSheet.absoluteFill, { top: -30 }]}
            pointerEvents="none"
          />
          <NCButton
            variant={selected === 'club' ? 'gold' : 'primary'}
            size="lg"
            full
            iconRight="arrowR"
            onPress={handlePurchase}
          >
            {`${selected === 'club' ? 'Club starten' : 'Plus starten'} — ${
              tier
                ? tier.price_monthly.toLocaleString('de', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                : '0,00'
            }€/Monat`}
          </NCButton>
        </View>
      )}

      {!MEMBERSHIPS_PURCHASABLE && selected !== 'free' && (
        <View style={s.footer}>
          <LinearGradient
            colors={['rgba(10,10,20,0)', NC.bg]}
            style={[StyleSheet.absoluteFill, { top: -30 }]}
            pointerEvents="none"
          />
          <Text style={s.comingSoon}>
            Mitgliedschaften kommen bald. Alle Turniere und Platzbuchungen sind derzeit für alle
            Mitglieder geöffnet.
          </Text>
        </View>
      )}
    </NCScreen>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const COMPARE: [string, string, string, string][] = [
  ['Early Access', '–', '24h', '48h'],
  ['Rabatt', '–', '10%', '20%'],
  ['Warteliste', 'Std.', 'Hoch', 'Top'],
];

const s = StyleSheet.create({
  topBar: {
    paddingHorizontal: 20,
    paddingTop: 62,
    paddingBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  glassBtn: {
    width: 40,
    height: 40,
    borderRadius: 999,
    backgroundColor: 'rgba(10,10,20,0.55)',
    borderWidth: 1,
    borderColor: NC.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontFamily: fontFamily.displayExtra,
    fontSize: 22,
    fontWeight: '800',
    color: NC.textP,
    letterSpacing: -0.5,
  },

  toggle: {
    flexDirection: 'row',
    backgroundColor: NC.bgCard,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: NC.border,
    padding: 4,
    overflow: 'hidden',
  },
  toggleBtn: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  toggleText: {
    fontFamily: fontFamily.displayBold,
    fontWeight: '700',
    fontSize: 13,
    letterSpacing: 0.1,
  },

  tierIcon: {
    width: 72,
    height: 72,
    borderRadius: 20,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroName: {
    marginTop: 14,
    fontFamily: fontFamily.displayExtra,
    fontSize: 28,
    fontWeight: '800',
    color: NC.textP,
    letterSpacing: -0.7,
  },
  heroPrice: {
    marginTop: 4,
    fontFamily: fontFamily.monoMedium,
    fontSize: 13,
    color: NC.textS,
  },
  perkRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  perkCheck: {
    width: 22,
    height: 22,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  perkText: {
    fontFamily: fontFamily.uiMedium,
    fontSize: 13.5,
    color: NC.textP,
    fontWeight: '500',
  },

  compareTitle: {
    fontFamily: fontFamily.displayBold,
    fontWeight: '700',
    fontSize: 14,
    color: NC.textP,
    letterSpacing: -0.2,
    marginBottom: 10,
  },
  compareRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  compareLabel: {
    flex: 1.2,
    fontFamily: fontFamily.uiSemibold,
    fontSize: 12,
    color: NC.textS,
    fontWeight: '600',
  },
  compareValue: {
    flex: 1,
    fontFamily: fontFamily.monoBold,
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'center',
  },
  legal: {
    paddingHorizontal: 20,
    marginTop: 22,
    fontFamily: fontFamily.uiMedium,
    fontSize: 11,
    color: NC.textT,
    textAlign: 'center',
    lineHeight: 16,
  },
  footer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingTop: 14,
    paddingBottom: 28,
    paddingHorizontal: 20,
    backgroundColor: NC.bg,
  },
  comingSoon: {
    color: NC.textS,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
  },
});
