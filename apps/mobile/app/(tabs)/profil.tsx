/**
 * Night Court — Profil screen.
 *
 * Layout:
 *   1. Identity card (avatar / name / handle / TOURNEO PLUS badge)
 *   2. 3-up StatBig grid (ELO · Winrate · Streak)
 *   3. Achievements horizontal shelf
 *   4. Membership upsell card → /membership
 *   5. Settings list (Mitgliedschaft · Benachrichtigungen · Einstellungen · Rechtliches · Abmelden)
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
  NCAvatar,
  NCSection,
  NCButton,
  NCIcon,
  NC,
  type IconName,
} from '../../src/components/nightcourt';
import { fontFamily } from '../../src/theme/typography';
import { useAuthStore } from '../../src/store/authStore';
import { MEMBERSHIPS_PURCHASABLE } from '../../src/config/features';
import { getMyElo, getMyAchievements, type EloTier } from '../../src/api/v2';

interface EloPart {
  elo: number;
  peak: number;
  tier: EloTier;
}

const ACHIEVEMENT_LABEL: Record<string, string> = {
  first_win: 'First Trophy',
  first_tournament: 'Debut',
  podium: 'Podium',
  veteran: 'Veteran',
  streak_3: '3-Win Streak',
  streak_5: '5-Win Streak',
  streak_10: 'Iron Will',
  elo_1000: 'Gold Tier',
  elo_1200: 'Diamond Tier',
};

const ACHIEVEMENT_HUE: Record<string, number> = {
  first_win: 45,
  first_tournament: 200,
  podium: 280,
  veteran: 30,
  streak_3: 15,
  streak_5: 15,
  streak_10: 0,
  elo_1000: 45,
  elo_1200: 240,
};

const ACHIEVEMENT_ICON: Record<string, IconName> = {
  first_win: 'crown',
  first_tournament: 'target',
  podium: 'trophy',
  veteran: 'shield',
  streak_3: 'flame',
  streak_5: 'flame',
  streak_10: 'bolt',
  elo_1000: 'medal',
  elo_1200: 'star',
};

export default function ProfilScreen() {
  const router = useRouter();
  const { user, logout } = useAuthStore();
  const [elo, setElo] = useState<{ padel: EloPart; matches: number } | null>(null);
  const [achievements, setAchievements] = useState<{ id: number; type: string }[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const e = await getMyElo();
        setElo({ padel: e.padel, matches: e.matches_played });
      } catch {
        // ignore
      }
      try {
        const a = await getMyAchievements();
        setAchievements(a.map((x) => ({ id: x.id, type: x.achievement_type })));
      } catch {
        // ignore
      }
    })();
  }, []);

  const memberTier: 'free' | 'plus' | 'club' = ((user as any)?.membership_tier ?? 'free') as
    | 'free'
    | 'plus'
    | 'club';
  const isPlus = memberTier === 'plus';
  const isClub = memberTier === 'club';

  const displayName = user?.display_name || user?.first_name || 'Tourneo Spieler';
  const handle = user?.email ? `@${user.email.split('@')[0]}` : '@tourneo';

  const winrate = 0; // backend exposes /me/stats but isn't surfaced in v2 yet
  const streak = 0;

  const handleLogout = () => {
    Alert.alert('Abmelden', 'Möchtest du dich wirklich abmelden?', [
      { text: 'Abbrechen', style: 'cancel' },
      {
        text: 'Abmelden',
        style: 'destructive',
        onPress: async () => {
          await logout();
          router.replace('/(auth)/login');
        },
      },
    ]);
  };

  return (
    <NCScreen>
      <ScrollView
        contentContainerStyle={{ paddingBottom: 110 }}
        showsVerticalScrollIndicator={false}
      >
        <View style={s.topBar}>
          <Text style={s.screenTitle}>Profil</Text>
          <Pressable
            style={s.iconBtn}
            accessibilityLabel="Einstellungen"
            onPress={() => router.push('/settings')}
          >
            <NCIcon name="settings" size={18} color={NC.textP} />
          </Pressable>
        </View>

        {/* Identity card */}
        <View style={{ paddingHorizontal: 20, paddingTop: 18 }}>
          <NCCard padded={false} style={{ overflow: 'hidden' }}>
            <LinearGradient
              colors={['rgba(99,102,241,0.18)', NC.bgCard]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={{ padding: 22, alignItems: 'center' }}
            >
              <NCAvatar name={displayName} hue={250} size={96} ring />
              <Text style={s.identityName}>{displayName}</Text>
              <Text style={s.identityHandle}>{handle}</Text>
              {memberTier !== 'free' ? (
                <View style={[s.tierBadge, isClub ? s.tierClub : s.tierPlus]}>
                  <NCIcon name={isClub ? 'crown' : 'sparkle'} size={12} color={isClub ? NC.gold : NC.primaryLight} />
                  <Text style={[s.tierLabel, { color: isClub ? NC.gold : NC.primaryLight }]}>
                    {isClub ? 'TOURNEO CLUB' : 'TOURNEO PLUS'}
                  </Text>
                </View>
              ) : null}
            </LinearGradient>
          </NCCard>
        </View>

        {/* Stat grid */}
        <View style={s.statGrid}>
          <StatBig value={elo?.padel?.elo ?? '—'} label="ELO" mono />
          <StatBig value={`${winrate}%`} label="Winrate" />
          <StatBig value={streak} label="Streak" icon="flame" />
        </View>

        {/* Achievements */}
        {achievements.length > 0 ? (
          <NCSection title="Achievements" style={{ marginTop: 22 }}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 20, gap: 10 }}
            >
              {achievements.slice(0, 8).map((a) => (
                <AchievementTile
                  key={a.id}
                  type={a.type}
                />
              ))}
            </ScrollView>
          </NCSection>
        ) : null}

        {/* Membership upsell — hidden while nothing can be bought. An
            advertisement for a product with no purchase path is exactly
            what App Review flags. */}
        {MEMBERSHIPS_PURCHASABLE && !isClub ? (
          <View style={{ paddingHorizontal: 20, marginTop: 6 }}>
            <NCCard
              padded={false}
              onPress={() => router.push('/membership')}
              style={{ overflow: 'hidden', borderColor: 'rgba(245,158,11,0.25)' }}
            >
              <LinearGradient
                colors={['rgba(245,158,11,0.18)', NC.bgCard]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={s.membershipRow}
              >
                <LinearGradient
                  colors={[NC.goldLight, NC.gold]}
                  style={s.membershipIcon}
                >
                  <NCIcon name="crown" size={24} color="#1A120B" strokeWidth={2.2} />
                </LinearGradient>
                <View style={{ flex: 1 }}>
                  <Text style={s.membershipTitle}>
                    {isPlus ? 'Upgrade auf Club' : 'Upgrade auf Plus'}
                  </Text>
                  <Text style={s.membershipSub}>
                    {isPlus
                      ? '−20% Gebühren · 48 h Early Access · Club-Events'
                      : '−10% Gebühren · 24 h Early Access · Plus Badge'}
                  </Text>
                </View>
                <NCIcon name="chevron" size={18} color={NC.gold} />
              </LinearGradient>
            </NCCard>
          </View>
        ) : null}

        {/* Settings list */}
        <View style={{ paddingHorizontal: 20, marginTop: 22 }}>
          <NCCard padded={false} style={{ overflow: 'hidden' }}>
            <SettingRow
              icon="ticket"
              label="Mitgliedschaft"
              hint={`Tourneo ${memberTier === 'club' ? 'Club' : memberTier === 'plus' ? 'Plus' : 'Free'}`}
              onPress={() => router.push('/membership')}
            />
            <SettingRow
              icon="bell"
              label="Benachrichtigungen"
              onPress={() => router.push('/notifications')}
            />
            <SettingRow icon="flame" label="Challenges & Streak" onPress={() => router.push('/challenges')} />
            <SettingRow icon="settings" label="Einstellungen" onPress={() => router.push('/settings')} />
            <SettingRow icon="users" label="Mein QR-Code" onPress={() => router.push('/my-qr')} />
            <SettingRow icon="shield" label="Rechtliches" onPress={() => router.push('/legal/datenschutz')} />
            <SettingRow icon="close" label="Abmelden" onPress={handleLogout} danger last />
          </NCCard>
        </View>

        {/* App version */}
        <Text style={s.version}>Tourneo · Night Court</Text>
      </ScrollView>
    </NCScreen>
  );
}

// ─── Sub-components ─────────────────────────────────────────
const StatBig: React.FC<{
  value: string | number;
  label: string;
  mono?: boolean;
  icon?: IconName;
}> = ({ value, label, mono, icon }) => (
  <NCCard padded={false} style={{ flex: 1, padding: 14, alignItems: 'center' }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      {icon ? <NCIcon name={icon} size={18} color={NC.gold} /> : null}
      <Text
        style={{
          fontFamily: mono ? fontFamily.monoBold : fontFamily.displayExtra,
          fontWeight: '800',
          fontSize: 22,
          color: NC.textP,
          letterSpacing: -0.5,
          lineHeight: 24,
        }}
      >
        {value}
      </Text>
    </View>
    <Text style={s.statLabel}>{label}</Text>
  </NCCard>
);

const AchievementTile: React.FC<{ type: string }> = ({ type }) => {
  const label = ACHIEVEMENT_LABEL[type] ?? type;
  const hue = ACHIEVEMENT_HUE[type] ?? 240;
  const icon: IconName = ACHIEVEMENT_ICON[type] ?? 'star';
  return (
    <View style={s.achTile}>
      <LinearGradient
        colors={[`hsl(${hue}, 65%, 55%)`, `hsl(${(hue + 340) % 360}, 60%, 35%)`]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={s.achIcon}
      >
        <NCIcon name={icon} size={24} color="#FFFFFF" strokeWidth={2} />
      </LinearGradient>
      <Text style={s.achLabel} numberOfLines={2}>
        {label}
      </Text>
    </View>
  );
};

const SettingRow: React.FC<{
  icon: IconName;
  label: string;
  hint?: string;
  onPress: () => void;
  danger?: boolean;
  last?: boolean;
}> = ({ icon, label, hint, onPress, danger, last }) => {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        s.settingRow,
        !last && { borderBottomColor: NC.divider, borderBottomWidth: 1 },
        pressed && { backgroundColor: NC.bgHover },
      ]}
    >
      <View style={[s.settingIconWrap, danger && { backgroundColor: 'rgba(255,71,87,0.12)' }]}>
        <NCIcon name={icon} size={16} color={danger ? NC.coral : NC.primaryLight} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[s.settingLabel, danger && { color: NC.coral }]}>{label}</Text>
        {hint ? <Text style={s.settingHint}>{hint}</Text> : null}
      </View>
      {!danger ? <NCIcon name="chevron" size={16} color={NC.textT} /> : null}
    </Pressable>
  );
};

// ─── Styles ─────────────────────────────────────────────────
const s = StyleSheet.create({
  topBar: {
    paddingHorizontal: 20,
    paddingTop: 62,
    paddingBottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  screenTitle: {
    fontFamily: fontFamily.displayExtra,
    fontSize: 24,
    fontWeight: '800',
    color: NC.textP,
    letterSpacing: -0.6,
  },
  iconBtn: {
    width: 42,
    height: 42,
    borderRadius: 999,
    backgroundColor: NC.bgCard,
    borderWidth: 1,
    borderColor: NC.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  identityName: {
    marginTop: 12,
    fontFamily: fontFamily.displayExtra,
    fontSize: 22,
    fontWeight: '800',
    color: NC.textP,
    letterSpacing: -0.5,
  },
  identityHandle: {
    marginTop: 2,
    fontFamily: fontFamily.monoMedium,
    fontSize: 12,
    color: NC.textS,
  },
  tierBadge: {
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  tierPlus: {
    backgroundColor: 'rgba(129,140,248,0.18)',
    borderColor: 'rgba(129,140,248,0.35)',
  },
  tierClub: {
    backgroundColor: 'rgba(245,158,11,0.18)',
    borderColor: 'rgba(245,158,11,0.35)',
  },
  tierLabel: {
    fontFamily: fontFamily.displayBold,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  statGrid: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    paddingTop: 14,
    gap: 10,
  },
  statLabel: {
    marginTop: 6,
    fontFamily: fontFamily.uiSemibold,
    fontSize: 10.5,
    color: NC.textT,
    fontWeight: '600',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },

  membershipRow: { padding: 16, flexDirection: 'row', alignItems: 'center', gap: 14 },
  membershipIcon: {
    width: 48,
    height: 48,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  membershipTitle: {
    fontFamily: fontFamily.displayBold,
    fontSize: 15,
    fontWeight: '700',
    color: NC.textP,
    letterSpacing: -0.3,
  },
  membershipSub: {
    marginTop: 2,
    fontFamily: fontFamily.uiMedium,
    fontSize: 12,
    color: NC.textS,
  },

  achTile: {
    width: 96,
    padding: 12,
    borderRadius: 16,
    backgroundColor: NC.bgCard,
    borderWidth: 1,
    borderColor: NC.border,
    alignItems: 'center',
  },
  achIcon: {
    width: 48,
    height: 48,
    borderRadius: 14,
    marginBottom: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  achLabel: {
    textAlign: 'center',
    fontFamily: fontFamily.uiSemibold,
    fontSize: 10.5,
    color: NC.textP,
    fontWeight: '600',
    lineHeight: 13,
  },

  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  settingIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: NC.primaryBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  settingLabel: {
    fontFamily: fontFamily.displaySemibold,
    fontSize: 14,
    fontWeight: '600',
    color: NC.textP,
    letterSpacing: -0.2,
  },
  settingHint: {
    marginTop: 2,
    fontFamily: fontFamily.uiMedium,
    fontSize: 11.5,
    color: NC.textS,
  },

  version: {
    textAlign: 'center',
    marginTop: 22,
    fontFamily: fontFamily.uiMedium,
    fontSize: 11,
    color: NC.textT,
  },
});
