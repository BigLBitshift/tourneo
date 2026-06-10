/**
 * deepLinks — central helpers for building shareable URLs that resolve to
 * the in-app equivalent via expo-router + universal links.
 *
 * - Web host: tourneo.de (matches app.json associatedDomains / intentFilters)
 * - Custom scheme: tourneo:// (local dev / fallback)
 *
 * The web base can be overridden via EXPO_PUBLIC_WEB_BASE to point at a
 * staging environment.
 */
const WEB_BASE = (process.env.EXPO_PUBLIC_WEB_BASE ?? 'https://tourneo.de').replace(/\/$/, '');
const SCHEME = 'tourneo://';

function buildPath(path: string): string {
  return path.replace(/^\//, '');
}

export const deepLinks = {
  /** Web URL — preferred for share sheets (universal link on iOS). */
  web(path: string): string {
    return `${WEB_BASE}/${buildPath(path)}`;
  },
  /** Custom scheme URL — for QR codes or fallback handoff. */
  scheme(path: string): string {
    return `${SCHEME}${buildPath(path)}`;
  },
  event(id: number | string): string {
    return deepLinks.web(`event/${id}`);
  },
  profile(userId: number | string): string {
    return deepLinks.web(`profile/${userId}`);
  },
  venue(id: number | string): string {
    return deepLinks.web(`venue/${id}`);
  },
  matchmaking(): string {
    return deepLinks.web('matchmaking');
  },
  bracket(eventId: number | string): string {
    return deepLinks.web(`event/bracket/${eventId}`);
  },
  match(matchId: number | string): string {
    return deepLinks.web(`match/${matchId}`);
  },
};

/**
 * Extract in-app route from a deep-link URL (https or custom scheme).
 * Returns `null` for unknown hosts/schemes.
 */
export function parseDeepLink(url: string): string | null {
  if (!url) return null;
  try {
    if (url.startsWith(SCHEME)) {
      const path = url.slice(SCHEME.length);
      return `/${buildPath(path)}`;
    }
    const u = new URL(url);
    if (u.host === 'tourneo.de' || u.host === 'www.tourneo.de') {
      return `${u.pathname}${u.search}`;
    }
  } catch {
    return null;
  }
  return null;
}
