/**
 * Night Court — Event Detail screen.
 *
 * Layout:
 *   1. Hero (340 px tall) with court-diagram backdrop, glass back/share/bookmark
 *      buttons, title + meta overlay.
 *   2. Prize-pool card with #1/#2/#3 breakdown.
 *   3. Plätze + Format info tiles.
 *   4. Static bracket preview.
 *   5. About / organiser / cancellation policy.
 *   6. Sticky CTA footer with member price + "Anmelden" → opens RegisterSheet.
 */
import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  Pressable,
  RefreshControl,
  Alert,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';
import Svg, { Rect, Path, Text as SvgText, Defs, LinearGradient as SvgLinearGradient, Stop } from 'react-native-svg';
import {
  NCScreen,
  NCCard,
  NCPill,
  NCButton,
  NCAvatar,
  NCCapacityBar,
  NCCourtBackdrop,
  NCIcon,
  RegisterSheet,
  NC,
} from '../../src/components/nightcourt';
import { fontFamily } from '../../src/theme/typography';
import { useEventStore } from '../../src/store/eventStore';
import { useAuthStore } from '../../src/store/authStore';
import { StandingsTable, AmericanoView } from '../../src/components/events';

export default function EventDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { currentEvent, fetchEventById, loading } = useEventStore();
  const { user } = useAuthStore();
  const [refreshing, setRefreshing] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  useEffect(() => {
    if (id) fetchEventById(Number(id));
  }, [id, fetchEventById]);

  const onRefresh = async () => {
    setRefreshing(true);
    if (id) await fetchEventById(Number(id));
    setRefreshing(false);
  };

  if (!currentEvent || (loading && !currentEvent)) {
    return (
      <NCScreen>
        <View style={s.loading}>
          <Text style={s.loadingText}>Wird geladen…</Text>
        </View>
      </NCScreen>
    );
  }

  const e = currentEvent;
  const fee = e.entry_fee_cents / 100;
  const prizeTotal = e.total_prize_pool_cents / 100;
  const filled = e.participant_count;
  const spots = e.max_participants;
  const fillPct = spots > 0 ? (filled / spots) * 100 : 0;
  const isMember = !!user && (user as any).membership_tier && (user as any).membership_tier !== 'free';
  const memberFee = isMember ? fee * 0.9 : fee;
  const dateFull = formatDateFull(e.start_date);

  const handleRegister = () => {
    if (!user) {
      Alert.alert(
        'Anmeldung erforderlich',
        'Bitte melde dich an, um dich für ein Turnier zu registrieren.',
        [
          { text: 'Abbrechen', style: 'cancel' },
          { text: 'Anmelden', onPress: () => router.push('/(auth)/login') },
        ]
      );
      return;
    }
    setSheetOpen(true);
  };

  const prizes = breakdownFor(e.prize_distribution, prizeTotal);

  return (
    <NCScreen>
      <ScrollView
        contentContainerStyle={{ paddingBottom: 130 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={NC.primaryLight}
          />
        }
      >
        {/* Hero */}
        <View style={{ height: 340, position: 'relative' }}>
          <NCCourtBackdrop height={340} large />
          <View style={s.heroNav}>
            <Pressable
              onPress={() => router.back()}
              style={s.glassBtn}
              accessibilityRole="button"
              accessibilityLabel="Zurück"
            >
              <NCIcon name="chevronL" size={20} color={NC.textP} />
            </Pressable>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Pressable style={s.glassBtn} accessibilityLabel="Teilen">
                <NCIcon name="share" size={17} color={NC.textP} />
              </Pressable>
              <Pressable style={s.glassBtn} accessibilityLabel="Merken">
                <NCIcon name="heart" size={17} color={NC.textP} />
              </Pressable>
            </View>
          </View>

          <View style={s.heroBottom}>
            <View style={{ flexDirection: 'row', gap: 6, marginBottom: 10 }}>
              <NCPill color="#FFFFFF" bg={NC.primary}>
                {`${labelSport(e.sport_category)} · ${labelLevel(e.level)}`}
              </NCPill>
              {prizeTotal > 0 ? (
                <NCPill color={NC.gold} bg={NC.goldBg}>
                  GARANTIERT
                </NCPill>
              ) : null}
            </View>
            <Text style={s.heroTitle} numberOfLines={3}>
              {e.title}
            </Text>
            <View style={s.heroMeta}>
              <View style={s.metaRow}>
                <NCIcon name="calendar" size={14} color="rgba(255,255,255,0.85)" />
                <Text style={s.heroMetaText}>{dateFull}</Text>
              </View>
              {e.venue?.name ? (
                <View style={s.metaRow}>
                  <NCIcon name="pin" size={14} color="rgba(255,255,255,0.85)" />
                  <Text style={s.heroMetaText} numberOfLines={1}>
                    {e.venue.name}
                  </Text>
                </View>
              ) : null}
            </View>
          </View>
        </View>

        {/* Prize pool */}
        {prizeTotal > 0 ? (
          <View style={{ paddingHorizontal: 20, paddingTop: 20 }}>
            <NCCard
              padded={false}
              style={{
                borderColor: 'rgba(245,158,11,0.25)',
                overflow: 'hidden',
              }}
            >
              <LinearGradient
                colors={['rgba(245,158,11,0.14)', NC.bgCard]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={{ padding: 18 }}
              >
                <View style={s.prizeHeader}>
                  <View>
                    <Text style={s.prizeLabel}>PRIZE POOL</Text>
                    <Text style={s.prizeAmount}>
                      {prizeTotal.toLocaleString('de', { maximumFractionDigits: 0 })}€
                    </Text>
                  </View>
                  <NCIcon name="trophy" size={38} color={NC.gold} strokeWidth={1.6} />
                </View>
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <PrizeRow rank="1" amount={prizes[0]} color={NC.gold} />
                  <PrizeRow rank="2" amount={prizes[1]} color="#CBD5E1" />
                  <PrizeRow rank="3" amount={prizes[2]} color="#D97706" />
                </View>
              </LinearGradient>
            </NCCard>
          </View>
        ) : null}

        {/* Spots + format */}
        <View style={s.tilesRow}>
          <InfoTile
            label="Plätze"
            value={`${filled}/${spots}`}
            sub={`${Math.max(0, spots - filled)} frei`}
            progress={fillPct}
          />
          <InfoTile label="Format" value={labelFormat(e.format)} sub="Single Elim." />
        </View>

        {/* Bracket */}
        <View style={{ paddingHorizontal: 20, paddingTop: 20 }}>
          <View style={s.subHeader}>
            <Text style={s.subTitle}>Turnierbaum Vorschau</Text>
            <Text style={s.subAction}>Single Elim.</Text>
          </View>
          <NCCard padded={false} style={{ padding: 14 }}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <BracketSVG />
            </ScrollView>
          </NCCard>
        </View>

        {/* About */}
        {e.description ? (
          <View style={{ paddingHorizontal: 20, paddingTop: 20 }}>
            <Text style={s.subTitle}>Über das Turnier</Text>
            <Text style={s.body}>{e.description}</Text>
          </View>
        ) : null}

        {/* Notes */}
        {e.special_notes ? (
          <View style={{ paddingHorizontal: 20, paddingTop: 20 }}>
            <Text style={s.subTitle}>Hinweise & Regeln</Text>
            <Text style={s.body}>{e.special_notes}</Text>
          </View>
        ) : null}

        {/* Organiser */}
        {e.venue?.name ? (
          <View style={{ paddingHorizontal: 20, paddingTop: 20 }}>
            <NCCard padded={false} style={s.orgCard}>
              <NCAvatar name={e.venue.name} hue={220} size={44} />
              <View style={{ flex: 1 }}>
                <Text style={s.orgTitle}>{e.venue.name}</Text>
                <Text style={s.orgSub}>Verifizierter Veranstalter</Text>
              </View>
              <NCButton variant="ghost" size="sm">
                Folgen
              </NCButton>
            </NCCard>
          </View>
        ) : null}

        {/* Round-robin standings + Americano session.
            Both components self-handle the empty case (return null) so a
            non-Americano single-elim event simply doesn't render them. */}
        {e.elimination_type === 'round_robin' && (
          <View style={{ paddingHorizontal: 20, paddingTop: 20, gap: 12 }}>
            <Text style={s.subTitle}>Tabelle</Text>
            <StandingsTable eventId={e.id} />
          </View>
        )}
        <View style={{ paddingHorizontal: 20, paddingTop: 20, gap: 12 }}>
          <AmericanoView eventId={e.id} currentUserId={user?.id} />
        </View>

        {/* Cancellation */}
        <View style={{ paddingHorizontal: 20, paddingTop: 20 }}>
          <NCCard padded={false} style={{ padding: 14 }}>
            <Text style={s.subTitle}>Stornierungsrichtlinie</Text>
            <Text style={s.body}>
              • 14+ Tage vor Event: 75% Erstattung{'\n'}
              • Weniger als 14 Tage: keine Erstattung{'\n'}
              • Stornierung durch Veranstalter: 100% Erstattung
            </Text>
          </NCCard>
        </View>
      </ScrollView>

      {/* Sticky footer */}
      <View pointerEvents="box-none" style={s.footer}>
        <LinearGradient
          colors={['rgba(10,10,20,0)', NC.bg]}
          start={{ x: 0, y: 0 }}
          end={{ x: 0, y: 1 }}
          style={[StyleSheet.absoluteFill, { top: -30 }]}
          pointerEvents="none"
        />
        <View style={s.footerRow}>
          <View style={{ flexShrink: 0 }}>
            <Text style={s.footerLabel}>{isMember ? 'PLUS-PREIS' : 'GEBÜHR'}</Text>
            <View style={s.footerPriceRow}>
              <Text style={s.footerPrice}>
                {memberFee.toLocaleString('de', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}€
              </Text>
              {isMember && fee !== memberFee ? (
                <Text style={s.footerStrike}>
                  {fee.toLocaleString('de', { maximumFractionDigits: 0 })}€
                </Text>
              ) : null}
            </View>
          </View>
          <View style={{ flex: 1 }}>
            <NCButton variant="primary" size="lg" full iconRight="arrowR" onPress={handleRegister}>
              Anmelden
            </NCButton>
          </View>
        </View>
      </View>

      <RegisterSheet
        visible={sheetOpen}
        onClose={() => setSheetOpen(false)}
        eventId={e.id}
        eventTitle={e.title}
        eventDateLabel={dateFull}
        feeCents={e.entry_fee_cents}
        isMember={isMember}
        onSuccess={() => fetchEventById(Number(id))}
      />
    </NCScreen>
  );
}

// ─── Sub-components ─────────────────────────────────────────
const PrizeRow: React.FC<{ rank: string; amount: number; color: string }> = ({
  rank,
  amount,
  color,
}) => (
  <View style={prizeStyles.row}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 2 }}>
      <NCIcon name="medal" size={13} color={color} strokeWidth={2} />
      <Text style={[prizeStyles.rank, { color }]}>#{rank}</Text>
    </View>
    <Text style={prizeStyles.amount}>
      {amount > 0 ? `${amount.toLocaleString('de', { maximumFractionDigits: 0 })}€` : '–'}
    </Text>
  </View>
);

const InfoTile: React.FC<{
  label: string;
  value: string;
  sub: string;
  progress?: number;
}> = ({ label, value, sub, progress }) => (
  <NCCard padded={false} style={{ flex: 1, padding: 14 }}>
    <Text style={infoStyles.label}>{label}</Text>
    <Text style={infoStyles.value}>{value}</Text>
    <Text style={infoStyles.sub}>{sub}</Text>
    {typeof progress === 'number' ? (
      <NCCapacityBar fill={progress} height={4} style={{ marginTop: 10 }} />
    ) : null}
  </NCCard>
);

const BracketSVG: React.FC = () => {
  const W = 540;
  const H = 240;
  const matches = [
    { p1: 'Kramer/Weiss', p2: 'Rahm/Torres', w: 0 as 0 | 1 },
    { p1: 'Neumann/Feldt', p2: 'Groß/Berger', w: 1 as 0 | 1 },
    { p1: 'Park/Hoang', p2: 'Silva/Ito', w: 0 as 0 | 1 },
    { p1: 'Abassi/Mu.', p2: 'Lenz/Koch', w: 1 as 0 | 1 },
  ];
  return (
    <Svg width={W} height={H}>
      <Defs>
        <SvgLinearGradient id="ncFinalGrad" x1="0" x2="1" y1="0" y2="0">
          <Stop offset="0" stopColor="rgba(245,158,11,0.2)" />
          <Stop offset="1" stopColor="rgba(99,102,241,0.15)" />
        </SvgLinearGradient>
      </Defs>
      {(['QF', 'SF', 'F'] as const).map((r, i) => (
        <SvgText
          key={r}
          x={50 + i * 180}
          y={14}
          fontFamily={fontFamily.uiBold}
          fontSize={10}
          fontWeight="700"
          fill={NC.textT}
          letterSpacing={1}
        >
          {r}
        </SvgText>
      ))}
      {matches.map((m, i) => {
        const y = 28 + i * 48;
        return (
          <React.Fragment key={i}>
            <Rect x={10} y={y} width={140} height={36} rx={8} fill={NC.bgInput} stroke={NC.border} />
            <SvgText
              x={18}
              y={y + 15}
              fontFamily={fontFamily.uiMedium}
              fontSize={10}
              fontWeight={m.w === 0 ? '700' : '500'}
              fill={m.w === 0 ? NC.textP : NC.textS}
            >
              {m.p1}
            </SvgText>
            <SvgText
              x={18}
              y={y + 29}
              fontFamily={fontFamily.uiMedium}
              fontSize={10}
              fontWeight={m.w === 1 ? '700' : '500'}
              fill={m.w === 1 ? NC.textP : NC.textS}
            >
              {m.p2}
            </SvgText>
            <Path
              d={`M150 ${y + 18} H175 V ${76 + Math.floor(i / 2) * 96} H 190`}
              stroke={NC.border}
              fill="none"
            />
          </React.Fragment>
        );
      })}
      {[0, 1].map((i) => {
        const y = 58 + i * 96;
        const winners = i === 0 ? ['Kramer/Weiss', 'Groß/Berger'] : ['Silva/Ito', 'Lenz/Koch'];
        return (
          <React.Fragment key={`sf${i}`}>
            <Rect x={190} y={y} width={140} height={36} rx={8} fill={NC.bgInput} stroke={NC.primary} strokeWidth={1} />
            <SvgText x={198} y={y + 15} fontFamily={fontFamily.uiMedium} fontSize={10} fontWeight="600" fill={NC.textP}>
              {winners[0]}
            </SvgText>
            <SvgText x={198} y={y + 29} fontFamily={fontFamily.uiMedium} fontSize={10} fontWeight="600" fill={NC.textS}>
              {winners[1]}
            </SvgText>
            <Path d={`M330 ${y + 18} H360 V 120 H 375`} stroke={NC.border} fill="none" />
          </React.Fragment>
        );
      })}
      <Rect x={375} y={102} width={150} height={40} rx={10} fill="url(#ncFinalGrad)" stroke={NC.gold} strokeWidth={1.5} />
      <SvgText x={385} y={119} fontFamily={fontFamily.uiBold} fontSize={10.5} fontWeight="700" fill={NC.textP}>
        Groß/Berger
      </SvgText>
      <SvgText x={385} y={134} fontFamily={fontFamily.uiBold} fontSize={10.5} fontWeight="700" fill={NC.textS}>
        TBD
      </SvgText>
    </Svg>
  );
};

// ─── Helpers ─────────────────────────────────────────────────
function formatDateFull(iso: string): string {
  if (!iso) return '';
  try {
    return format(new Date(iso), 'EEE, d. MMM yyyy', { locale: de });
  } catch {
    return iso.substring(0, 10);
  }
}

function labelLevel(raw?: string): string {
  return ({ beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced', pro: 'Pro', open: 'Offen' } as Record<string, string>)[raw || ''] || 'Open';
}

function labelFormat(raw?: string): string {
  return ({ singles: 'Einzel', doubles: 'Duo', team: 'Team' } as Record<string, string>)[raw || ''] || 'Best of';
}

function labelSport(raw?: string): string {
  return ({ padel: 'PADEL', fifa: 'FIFA' } as Record<string, string>)[raw || ''] || 'PADEL';
}

function breakdownFor(
  dist: { place: number; amount_cents: number }[] | undefined,
  total: number
): [number, number, number] {
  if (dist && dist.length) {
    const a = dist.find((d) => d.place === 1)?.amount_cents ?? 0;
    const b = dist.find((d) => d.place === 2)?.amount_cents ?? 0;
    const c = dist.find((d) => d.place === 3)?.amount_cents ?? 0;
    return [a / 100, b / 100, c / 100];
  }
  // 50% / 30% / 20% sensible default if backend hasn't returned a split
  return [Math.round(total * 0.5), Math.round(total * 0.3), Math.round(total * 0.2)];
}

// ─── Styles ─────────────────────────────────────────────────
const s = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  loadingText: { color: NC.textS, fontFamily: fontFamily.uiMedium, fontSize: 14 },

  heroNav: {
    position: 'absolute',
    top: 58,
    left: 16,
    right: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    zIndex: 2,
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
  heroBottom: { position: 'absolute', bottom: 30, left: 20, right: 20 },
  heroTitle: {
    fontFamily: fontFamily.displayExtra,
    fontSize: 30,
    fontWeight: '800',
    color: NC.textP,
    letterSpacing: -0.8,
    lineHeight: 32,
  },
  heroMeta: {
    flexDirection: 'row',
    gap: 14,
    marginTop: 10,
    flexWrap: 'wrap',
  },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  heroMetaText: { color: 'rgba(255,255,255,0.75)', fontFamily: fontFamily.uiMedium, fontSize: 13 },

  prizeHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  prizeLabel: {
    fontFamily: fontFamily.uiBold,
    fontSize: 11,
    color: NC.gold,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  prizeAmount: {
    fontFamily: fontFamily.displayExtra,
    fontSize: 30,
    fontWeight: '800',
    color: NC.gold,
    letterSpacing: -0.8,
  },

  tilesRow: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 20,
    paddingTop: 16,
  },

  subHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  subTitle: {
    fontFamily: fontFamily.displayBold,
    fontSize: 16,
    fontWeight: '700',
    color: NC.textP,
    letterSpacing: -0.3,
  },
  subAction: {
    fontFamily: fontFamily.uiSemibold,
    fontSize: 11,
    fontWeight: '600',
    color: NC.primaryLight,
  },
  body: {
    fontFamily: fontFamily.uiMedium,
    fontSize: 13.5,
    color: NC.textS,
    lineHeight: 21,
    marginTop: 10,
  },
  orgCard: { padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12 },
  orgTitle: {
    fontFamily: fontFamily.displayBold,
    fontSize: 14,
    fontWeight: '700',
    color: NC.textP,
    letterSpacing: -0.2,
  },
  orgSub: { marginTop: 2, fontFamily: fontFamily.uiMedium, fontSize: 11.5, color: NC.textS },

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
  footerRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  footerLabel: {
    fontFamily: fontFamily.uiSemibold,
    fontSize: 10.5,
    color: NC.textT,
    fontWeight: '600',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  footerPriceRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  footerPrice: {
    fontFamily: fontFamily.displayExtra,
    fontSize: 22,
    fontWeight: '800',
    color: NC.textP,
    letterSpacing: -0.5,
  },
  footerStrike: {
    fontFamily: fontFamily.uiMedium,
    fontSize: 12,
    color: NC.textT,
    textDecorationLine: 'line-through',
  },
});

const prizeStyles = StyleSheet.create({
  row: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: NC.border,
  },
  rank: {
    fontFamily: fontFamily.displayBold,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  amount: {
    marginTop: 2,
    fontFamily: fontFamily.displayExtra,
    fontSize: 15,
    fontWeight: '800',
    color: NC.textP,
    letterSpacing: -0.3,
  },
});

const infoStyles = StyleSheet.create({
  label: {
    fontFamily: fontFamily.uiSemibold,
    fontSize: 10.5,
    color: NC.textT,
    fontWeight: '600',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  value: {
    marginTop: 4,
    fontFamily: fontFamily.displayBold,
    fontSize: 20,
    fontWeight: '700',
    color: NC.textP,
    letterSpacing: -0.4,
  },
  sub: { marginTop: 2, fontFamily: fontFamily.uiMedium, fontSize: 11.5, color: NC.textS },
});
