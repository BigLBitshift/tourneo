/**
 * Build-time feature switches.
 *
 * `PAYMENTS_ENABLED` is deliberately a **compile-time constant**, not a
 * value fetched from the server. App Review judges the binary that was
 * submitted: a server-controlled flag could turn purchase UI on after
 * approval, which is exactly the pattern Apple rejects apps for. Shipping
 * it in the bundle means the reviewed build provably has no way to sell
 * anything.
 *
 * Off, Tourneo is a complete free app — tournaments register for free,
 * courts book as pay-at-venue, and the membership screen explains what is
 * coming instead of offering a purchase that cannot complete.
 *
 * To turn payments on later, set EXPO_PUBLIC_PAYMENTS_ENABLED=true and
 * rebuild. That requires StoreKit for the subscriptions and a live Stripe
 * account for tournament fees — see GO_LIVE_CHECKLIST.md. The backend has
 * a matching PAYMENTS_ENABLED switch; both must agree.
 */
export const PAYMENTS_ENABLED = process.env.EXPO_PUBLIC_PAYMENTS_ENABLED === 'true';

/** Paid membership tiers exist in the data model but cannot be bought yet. */
export const MEMBERSHIPS_PURCHASABLE = PAYMENTS_ENABLED;
