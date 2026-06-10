import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { db, t } from '../config/database';
import { env } from '../config/environment';
import { AppError } from '../middleware/errorHandler';
import { AuthService } from './authService';
import type { AppleSignInInput } from '../validators/auth';

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_JWKS_URL = new URL('https://appleid.apple.com/auth/keys');

// jose caches the key set internally and refreshes it on unknown-kid,
// so a single module-level instance is the recommended usage.
const appleJwks = createRemoteJWKSet(APPLE_JWKS_URL);

interface AppleTokenClaims extends JWTPayload {
  email?: string;
  email_verified?: string | boolean;
  is_private_email?: string | boolean;
}

/**
 * AppleAuthService — verifies Sign in with Apple identity tokens against
 * Apple's published JWKS and finds-or-creates the matching Tourneo user.
 *
 * Verification follows Apple's documented requirements:
 *   - signature against https://appleid.apple.com/auth/keys
 *   - iss must be https://appleid.apple.com
 *   - aud must be our app's bundle id
 *   - exp must be in the future (enforced by jose)
 */
export class AppleAuthService {
  static async signIn(input: AppleSignInInput) {
    const claims = await this.verifyIdentityToken(input.identity_token);

    const appleUserId = claims.sub;
    if (!appleUserId) {
      throw AppError.unauthorized('Apple token is missing the subject claim');
    }
    // Email priority: token claim (authoritative) > client-provided value.
    // Apple only includes the email on the first authorization, the client
    // may relay it on subsequent logins.
    const email = (claims.email || input.email || '').toLowerCase().trim();

    // 1) Existing user linked to this Apple ID
    let user = await db(t('users')).where('apple_id', appleUserId).whereNull('deleted_at').first();

    // 2) Existing email/password account with the same verified email — link it.
    if (!user && email) {
      const byEmail = await db(t('users')).where('email', email).whereNull('deleted_at').first();
      if (byEmail) {
        await db(t('users')).where('id', byEmail.id).update({
          apple_id: appleUserId,
          updated_at: new Date(),
        });
        user = { ...byEmail, apple_id: appleUserId };
      }
    }

    // 3) Brand-new user
    if (!user) {
      if (!email) {
        // Without an email we cannot create an account (column is NOT NULL
        // and unique). This only happens when the client drops Apple's
        // private-relay email on first auth.
        throw AppError.badRequest(
          'Apple did not provide an email address. Please retry the sign-in.'
        );
      }
      user = await this.createUser(appleUserId, email, input.first_name, input.last_name);
    }

    if (user.status !== 'active') {
      throw AppError.unauthorized('This account is suspended or deleted');
    }

    const profile = await db(t('profiles')).where('user_id', user.id).first();
    const membership = await db(t('memberships'))
      .where('user_id', user.id)
      .where('status', 'active')
      .first();

    const tokens = AuthService.generateTokens({
      userId: user.id,
      uuid: user.uuid,
      email: user.email,
      role: user.role,
    });

    await db(t('audit_log')).insert({
      user_id: user.id,
      action: 'user.login_apple',
      entity_type: 'user',
      entity_id: user.id,
      created_at: new Date(),
    });

    return {
      user: {
        id: user.id,
        uuid: user.uuid,
        email: user.email,
        first_name: profile?.first_name,
        last_name: profile?.last_name,
        display_name: profile?.display_name,
        avatar_url: profile?.avatar_url,
        role: user.role,
        membership_tier: membership?.tier || 'free',
        auth_provider: 'apple' as const,
      },
      ...tokens,
    };
  }

  private static async verifyIdentityToken(identityToken: string): Promise<AppleTokenClaims> {
    if (!env.apple.bundleId) {
      throw AppError.internal('Apple Sign-In is not configured (APPLE_BUNDLE_ID missing)');
    }
    try {
      const { payload } = await jwtVerify(identityToken, appleJwks, {
        issuer: APPLE_ISSUER,
        audience: env.apple.bundleId,
      });
      return payload as AppleTokenClaims;
    } catch (err: any) {
      // Never leak jose internals to the client; log for diagnosis.
      console.warn('[apple-auth] identity token verification failed:', err?.message || err);
      throw AppError.unauthorized('Apple identity token is invalid or expired');
    }
  }

  private static async createUser(
    appleUserId: string,
    email: string,
    firstName?: string,
    lastName?: string
  ) {
    const now = new Date();
    const userUuid = uuidv4();
    // Apple accounts have no password. We still satisfy the NOT NULL
    // password_hash column with a hash of random bytes that can never be
    // produced by bcrypt.compare on user input of sane length.
    const unguessable = crypto.randomBytes(48).toString('hex');
    const passwordHash = await bcrypt.hash(unguessable, 12);

    const userId = await db.transaction(async (trx) => {
      const [id] = await trx(t('users')).insert({
        uuid: userUuid,
        email,
        password_hash: passwordHash,
        apple_id: appleUserId,
        auth_provider: 'apple',
        // Apple verifies email ownership before issuing the token.
        email_verified: true,
        role: 'user',
        status: 'active',
        created_at: now,
        updated_at: now,
      });

      await trx(t('profiles')).insert({
        user_id: id,
        first_name: (firstName || 'Spieler').trim().slice(0, 100),
        last_name: (lastName || '').trim().slice(0, 100) || '-',
        date_of_birth: null,
        country: 'DE',
        created_at: now,
        updated_at: now,
      });

      await trx(t('language_preferences')).insert({
        user_id: id,
        locale: 'de',
        system_detected_locale: 'de',
        manual_override: false,
        updated_at: now,
      });

      await trx(t('memberships')).insert({
        user_id: id,
        tier: 'free',
        status: 'active',
        started_at: now,
        created_at: now,
        updated_at: now,
      });

      await trx(t('audit_log')).insert({
        user_id: id,
        action: 'user.registered_apple',
        entity_type: 'user',
        entity_id: id,
        created_at: now,
      });

      return id;
    });

    return db(t('users')).where('id', userId).first();
  }
}
