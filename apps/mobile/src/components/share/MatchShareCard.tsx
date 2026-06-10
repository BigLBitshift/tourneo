/**
 * MatchShareCard — the 9:16 visual that gets captured to PNG and shared
 * to Instagram Stories / WhatsApp status.
 *
 * Pure presentational component: rendering is detached from capturing
 * (see ShareCardSheet) so it can be previewed inline, snapshot-tested,
 * or reused for an in-app result screen later.
 *
 * Design: dark Night-Court gradient, big serif score, sponsor strip at
 * the bottom when the event carries sponsor branding.
 */
import React from 'react';
import { View, Text, StyleSheet, Image } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import type { MatchCard } from '../../api/v2';

export const SHARE_CARD_WIDTH = 360;
export const SHARE_CARD_HEIGHT = 640;

interface MatchShareCardProps {
  card: MatchCard;
}

function sideNames(side: MatchCard['participant_1']): string {
  if (!side) return '—';
  return side.players.map((p) => p.name).join(' & ');
}

export const MatchShareCard: React.FC<MatchShareCardProps> = ({ card }) => {
  const p1IsWinner = card.winner_registration_id === card.participant_1?.registration_id;
  const winner = p1IsWinner ? card.participant_1 : card.participant_2;
  const loser = p1IsWinner ? card.participant_2 : card.participant_1;
  const sportIcon = card.event?.sport_category === 'fifa' ? '🎮' : '🏸';

  return (
    <View style={styles.card}>
      <LinearGradient
        colors={['#0E1B4D', '#0A0A14', '#070710']}
        start={{ x: 0.2, y: 0 }}
        end={{ x: 0.8, y: 1 }}
        style={StyleSheet.absoluteFill}
      />

      <View style={styles.header}>
        <Text style={styles.brand}>TOURNEO</Text>
        {card.event?.title ? (
          <Text style={styles.eventTitle} numberOfLines={1}>
            {sportIcon} {card.event.title}
          </Text>
        ) : null}
        {card.round_name ? <Text style={styles.roundName}>{card.round_name}</Text> : null}
      </View>

      <View style={styles.body}>
        <Text style={styles.winnerLabel}>SIEGER</Text>
        <Text style={styles.winnerName} numberOfLines={2}>
          {sideNames(winner ?? null)}
        </Text>

        <View style={styles.scoreRow}>
          {card.sets.map((s) => {
            // Render from the winner's perspective so the bigger number is
            // always on the left — reads instantly in a story.
            const w = p1IsWinner ? s.p1 : s.p2;
            const l = p1IsWinner ? s.p2 : s.p1;
            return (
              <View key={s.set} style={styles.setBox}>
                <Text style={styles.setScore}>
                  {w}
                  <Text style={styles.setScoreDim}>:{l}</Text>
                </Text>
                {s.tiebreak ? <Text style={styles.tiebreak}>TB</Text> : null}
              </View>
            );
          })}
        </View>

        <Text style={styles.vsLine} numberOfLines={1}>
          gegen {sideNames(loser ?? null)}
        </Text>

        {card.elo_delta !== null && card.elo_delta > 0 && (
          <View style={styles.eloBadge}>
            <Text style={styles.eloText}>ELO +{card.elo_delta}</Text>
          </View>
        )}
      </View>

      <View style={styles.footer}>
        {card.venue?.name ? (
          <Text style={styles.venue}>📍 {card.venue.name}</Text>
        ) : null}
        {card.event?.sponsor_name ? (
          <View style={styles.sponsorStrip}>
            {card.event.sponsor_logo_url ? (
              <Image
                source={{ uri: card.event.sponsor_logo_url }}
                style={styles.sponsorLogo}
                resizeMode="contain"
              />
            ) : null}
            <Text style={styles.sponsorText}>präsentiert von {card.event.sponsor_name}</Text>
          </View>
        ) : null}
        <Text style={styles.hashtag}>#tourneo</Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    width: SHARE_CARD_WIDTH,
    height: SHARE_CARD_HEIGHT,
    borderRadius: 24,
    overflow: 'hidden',
    padding: 28,
    justifyContent: 'space-between',
  },
  header: { gap: 6 },
  brand: {
    color: '#8B9DFF',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 4,
  },
  eventTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: '700' },
  roundName: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  body: { alignItems: 'center', gap: 12 },
  winnerLabel: {
    color: '#FFD700',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 3,
  },
  winnerName: {
    color: '#FFFFFF',
    fontSize: 30,
    fontWeight: '800',
    textAlign: 'center',
    lineHeight: 36,
  },
  scoreRow: { flexDirection: 'row', gap: 10, marginTop: 6 },
  setBox: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  setScore: { color: '#FFFFFF', fontSize: 26, fontWeight: '800' },
  setScoreDim: { color: 'rgba(255,255,255,0.45)' },
  tiebreak: { color: '#FFD700', fontSize: 9, fontWeight: '800', marginTop: 2 },
  vsLine: { color: 'rgba(255,255,255,0.65)', fontSize: 15, marginTop: 4 },
  eloBadge: {
    backgroundColor: 'rgba(76,217,100,0.15)',
    borderColor: 'rgba(76,217,100,0.5)',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 6,
    marginTop: 4,
  },
  eloText: { color: '#4CD964', fontSize: 14, fontWeight: '800' },
  footer: { gap: 10, alignItems: 'center' },
  venue: { color: 'rgba(255,255,255,0.6)', fontSize: 13 },
  sponsorStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  sponsorLogo: { width: 24, height: 24, borderRadius: 4 },
  sponsorText: { color: 'rgba(255,255,255,0.7)', fontSize: 11 },
  hashtag: { color: '#8B9DFF', fontSize: 12, fontWeight: '700', letterSpacing: 1 },
});
