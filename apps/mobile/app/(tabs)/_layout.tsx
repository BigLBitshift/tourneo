/**
 * Night Court — Bottom tab bar.
 *
 * Five slots, custom-rendered:
 *   [Home] [Turniere] [FAB → Matchmaking] [Community] [Profil]
 *
 * The FAB is a 54-px indigo gradient circle floating −18 above the bar.
 * Background uses BlurView (`rgba(10,10,20,0.75)` + 24-px blur) per the
 * design spec.
 */
import React from 'react';
import { Tabs, useRouter } from 'expo-router';
import {
  View,
  Pressable,
  StyleSheet,
  Platform,
  Text,
  AccessibilityState,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';
import {
  NCIcon,
  NC,
  type IconName,
} from '../../src/components/nightcourt';
import { fontFamily } from '../../src/theme/typography';
import { useNotificationStore } from '../../src/store/notificationStore';

type TabSlot =
  | { kind: 'tab'; key: string; label: string; icon: IconName; route: string; badge?: number }
  | { kind: 'fab'; key: 'fab'; route: string };

function NightCourtTabBar({ state, descriptors, navigation }: any) {
  const router = useRouter();
  const unreadCount = useNotificationStore((s) => s.unreadCount);

  // We keep expo-router responsible for Home / Turniere / Profil routing.
  // Community is registered with `href: null` in the screen-options below
  // so we route it through the imperative router; Matchmaking is a stack
  // route outside the tab group.
  const slots: TabSlot[] = [
    { kind: 'tab', key: 'home', label: 'Home', icon: 'home', route: 'home', badge: unreadCount },
    { kind: 'tab', key: 'turniere', label: 'Turniere', icon: 'trophy', route: 'turniere' },
    { kind: 'fab', key: 'fab', route: '/play-now' },
    { kind: 'tab', key: 'community', label: 'Community', icon: 'users', route: '/(tabs)/community' },
    { kind: 'tab', key: 'profil', label: 'Profil', icon: 'user', route: 'profil' },
  ];

  return (
    <View style={styles.barWrap} pointerEvents="box-none">
      <BlurView
        intensity={24}
        tint="dark"
        style={[StyleSheet.absoluteFill, styles.blur]}
      />
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.tint]} />
      <View style={styles.row}>
        {slots.map((slot) => {
          if (slot.kind === 'fab') {
            return (
              <Pressable
                key={slot.key}
                accessibilityRole="button"
                accessibilityLabel="Matchmaking"
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
                  router.push(slot.route);
                }}
                style={styles.fab}
              >
                <LinearGradient
                  colors={[NC.primary, NC.primaryDark]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={StyleSheet.absoluteFill}
                />
                <NCIcon name="bolt" size={24} color="#FFFFFF" strokeWidth={2.5} />
              </Pressable>
            );
          }

          // For routes that are part of the Tabs (home, turniere, profil) we
          // hand off to the navigation event so expo-router stays in sync.
          const inTabs = ['home', 'turniere', 'profil'].includes(slot.route);
          const routeIndex = inTabs
            ? state.routes.findIndex((r: any) => r.name === slot.route)
            : -1;
          const focused = inTabs && state.index === routeIndex;
          const onPress = () => {
            Haptics.selectionAsync().catch(() => {});
            if (inTabs) {
              const event = navigation.emit({
                type: 'tabPress',
                target: state.routes[routeIndex]?.key,
                canPreventDefault: true,
              });
              if (!focused && !event.defaultPrevented) {
                navigation.navigate(slot.route);
              }
            } else {
              router.push(slot.route);
            }
          };

          return (
            <Pressable
              key={slot.key}
              onPress={onPress}
              accessibilityRole="button"
              accessibilityLabel={slot.label}
              accessibilityState={{ selected: focused } as AccessibilityState}
              style={styles.tab}
            >
              <View>
                <NCIcon
                  name={slot.icon}
                  size={22}
                  color={focused ? NC.primary : NC.textS}
                  strokeWidth={focused ? 2.4 : 2}
                />
                {slot.badge && slot.badge > 0 ? (
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>
                      {slot.badge > 9 ? '9+' : slot.badge}
                    </Text>
                  </View>
                ) : null}
              </View>
              <Text
                style={[
                  styles.label,
                  { color: focused ? NC.primary : NC.textS, opacity: focused ? 1 : 0.85 },
                ]}
              >
                {slot.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export default function TabLayout() {
  return (
    <Tabs
      tabBar={(props) => <NightCourtTabBar {...props} />}
      screenOptions={{ headerShown: false }}
    >
      <Tabs.Screen name="home" />
      <Tabs.Screen name="turniere" />
      <Tabs.Screen name="profil" />
      {/* spielen + community are routed through the FAB / quick tiles, not
          rendered as a tab. */}
      <Tabs.Screen name="spielen" options={{ href: null }} />
      <Tabs.Screen name="community" options={{ href: null }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  barWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 88,
    paddingTop: 10,
    paddingBottom: Platform.OS === 'ios' ? 26 : 14,
    overflow: 'visible',
    borderTopWidth: 1,
    borderTopColor: NC.border,
  },
  blur: {},
  tint: { backgroundColor: 'rgba(10,10,20,0.75)' },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-around',
  },
  tab: {
    minWidth: 54,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  label: {
    fontFamily: fontFamily.uiSemibold,
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  fab: {
    marginTop: -18,
    width: 54,
    height: 54,
    borderRadius: 999,
    overflow: 'hidden',
    borderWidth: 3,
    borderColor: NC.bg,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: NC.primary,
    shadowOpacity: 0.4,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 },
    elevation: 14,
  },
  badge: {
    position: 'absolute',
    top: -4,
    right: -8,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    backgroundColor: NC.coral,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    color: '#FFFFFF',
    fontFamily: fontFamily.uiBold,
    fontSize: 10,
    fontWeight: '700',
  },
});
