# Environment & Deployment Guide

Alle Umgebungsvariablen des Backends, wie man eine Staging-Umgebung aufsetzt
und welche Flows vor einem Produktiv-Launch einmal komplett durchgespielt
werden müssen.

## 1. Umgebungsvariablen (apps/backend/.env)

### Pflicht in Produktion (Startup bricht sonst ab — siehe `validateEnv()`)

| Variable | Beschreibung | Beispiel |
|---|---|---|
| `NODE_ENV` | `production` aktiviert die strikten Checks | `production` |
| `JWT_ACCESS_SECRET` | ≥ 32 Zeichen, zufällig | `openssl rand -hex 32` |
| `JWT_REFRESH_SECRET` | ≥ 32 Zeichen, **muss sich vom Access-Secret unterscheiden** | `openssl rand -hex 32` |
| `STRIPE_SECRET_KEY` | Stripe Secret Key (`sk_live_…` / Staging: `sk_test_…`) | |
| `STRIPE_WEBHOOK_SECRET` | Signing Secret des Webhook-Endpoints (`whsec_…`) | |
| `APP_URL` | Öffentliche Backend-URL (für E-Mail-Links) | `https://api.tourneo.de` |
| `ADMIN_URL` | URL des Admin-Dashboards (CORS) | `https://admin.tourneo.de` |
| `DB_PASSWORD` | MySQL-Passwort | |

### Datenbank

| Variable | Default | Beschreibung |
|---|---|---|
| `DB_HOST` | `localhost` | |
| `DB_PORT` | `3306` | |
| `DB_NAME` | `tourneo` | |
| `DB_USER` | `root` | |
| `DB_SSL` | `false` | `true` für Managed-DB-Anbieter |
| `DB_POOL_MIN` / `DB_POOL_MAX` | `2` / `10` | |
| `DB_TABLE_PREFIX` | `tourneo_` | Nicht ändern, sobald Daten existieren |

### Optionale Integrationen

| Variable | Wirkung wenn gesetzt |
|---|---|
| `REDIS_URL` | Aktiviert verteiltes Rate-Limiting **und BullMQ-Jobs** (sonst In-Process-Fallback) |
| `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` | Push-Notifications via FCM (sonst nur In-App) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM_NAME`, `SMTP_FROM_EMAIL` | Echte E-Mails (sonst nur Konsolen-Log) |
| `APPLE_BUNDLE_ID` | Pflicht für Apple Sign-In (`aud`-Check des Identity Tokens) |
| `APPLE_SHARED_SECRET`, `APPLE_IAP_ENVIRONMENT` | Apple In-App-Purchases (Membership) |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION` | Media-Uploads |
| `STRIPE_API_VERSION` | Pinned Stripe-API-Version (Default `2023-10-16`) |
| `LOG_LEVEL` | pino-Level (`debug`, `info`, `warn`, `error`) |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | Superadmin-Zugang beim Seed. Ohne `SEED_ADMIN_PASSWORD` wird ein zufälliges Passwort generiert und **einmalig** geloggt |

### Mobile (apps/mobile)

| Variable | Beschreibung |
|---|---|
| `EXPO_PUBLIC_API_BASE_URL` | Backend-URL inkl. `/api/v1`. Ohne sie: Simulator-Defaults (dev) bzw. `https://api.tourneo.de/api/v1` (prod) |

## 2. Staging-Umgebung aufsetzen

1. **Datenbank:** Leere MySQL 8 anlegen, dann
   ```bash
   npm run backend:migrate
   SEED_ADMIN_PASSWORD=<wähle-eins> npm run --workspace=apps/backend seed
   ```
2. **Stripe (Test-Mode):**
   - Test-Keys (`sk_test_…`) in `.env`
   - Webhook anlegen: `https://staging-api…/api/v1/payments/webhook`,
     Events: `payment_intent.succeeded`, `payment_intent.payment_failed`,
     `charge.refunded`. Das `whsec_…` in `STRIPE_WEBHOOK_SECRET`.
   - Lokal: `stripe listen --forward-to localhost:3000/api/v1/payments/webhook`
3. **Redis:** Kleinste Instanz reicht (Upstash/Railway/Fly). `REDIS_URL` setzen —
   dadurch laufen die Jobs (Match-Reminder, Waitlist-Expiry) über BullMQ.
4. **Firebase:** Eigenes Staging-Projekt, Service-Account-Key als drei Env-Vars.
5. **SMTP:** Staging mit [Mailpit](https://github.com/axllent/mailpit) oder
   einem Test-Postfach — niemals den Prod-Absender.

## 3. Launch-Checkliste: Flows einmal komplett durchspielen

- [ ] **Registrierung:** Account anlegen → Verifikations-Mail kommt an → Link klicken → `email_verified = true`
- [ ] **Login + Refresh:** Login, 15 Min warten (oder Access-Token-Expiry kurz stellen), App nutzt Refresh-Token ohne Logout
- [ ] **Apple Sign-In:** Auf echtem iOS-Gerät (Simulator kann kein SiwA), neuer + bestehender Account
- [ ] **Bezahlung:** Event-Anmeldung → Stripe-Test-Karte `4242 4242 4242 4242` → Webhook bestätigt → Registrierung `confirmed`, Bestätigungs-Mail kommt
- [ ] **Fehlzahlung:** Test-Karte `4000 0000 0000 0002` (declined) → Registrierung `cancelled`, Waitlist rückt nach
- [ ] **Refund:** Im Admin-Dashboard Refund anlegen + verarbeiten → Stripe zeigt Refund, Webhook setzt Status, User bekommt Notification
- [ ] **Waitlist:** Event mit `max_participants = 2` füllen, 3. Anmeldung → `waitlisted`; eine Anmeldung stornieren → Promotion-Push kommt; 24h nicht zahlen (oder `waitlist_promoted_at` zurückdatieren) → Expiry-Job storniert und promotet den Nächsten
- [ ] **Bracket:** Check-in → Bracket generieren → Ergebnisse eintragen → ELO ändert sich, Finale schließt Turnier ab, Sieger-Push kommt
- [ ] **DSGVO:** Datenexport anfordern, Account löschen → Login unmöglich, personenbezogene Daten bereinigt

## 4. Logging & Monitoring

- Backend loggt strukturiert über **pino** (`src/utils/logger.ts`).
  Lokal lesbar via `npm run dev | npx pino-pretty`.
- Empfohlen für Produktion: Log-Drain des Hosters (Railway/Fly/Render) oder
  Grafana Loki; zusätzlich **Sentry** fürs Error-Tracking
  (Mobile: `utils/crashReport.ts` ist vorbereitet, DSN eintragen genügt).
