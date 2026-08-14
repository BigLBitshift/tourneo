# Tourneo — Go-Live-Checkliste

> Stand: 2026-08-14 · Basis: vollständiger Audit über Backend, Mobile, Legal, Apple, CI/CD und alle Branches.
> Verifiziert gegen den Code — jede Aussage hat eine Fundstelle. Nicht verifizierbare Punkte sind als **[OWNER]** markiert.

---

## 0. Kurzfassung

Tourneo ist **kein Prototyp**. ~20.000 Zeilen Backend (27 Route-Module, 31 Services, 17 Migrationen, 164 Endpoints), ~26.000 Zeilen Mobile auf Expo SDK 54 / RN 0.81.5, TypeScript strict, 332 grüne Tests. Die Architektur ist tragfähig, die Sicherheitshygiene am Request-Layer ist überdurchschnittlich (Helmet+CSP, `validateEnv()` blockt Dev-Secrets in Prod, bcrypt cost 12, Stripe-Webhook-Signaturprüfung, `SELECT … FOR UPDATE` bei Refunds — kein Endpoint ohne Auth-Middleware, keine SQL-Injection in ~45 `db.raw`-Stellen).

Trotzdem ist die App **heute nicht einreichbar und nicht startbar**. Der Grund ist nicht die Architektur, sondern eine Handvoll durchtrennter Verbindungen zwischen App und Backend plus fehlende Betriebs- und Rechtsgrundlagen.

**Die vier Sätze, die zählen:**

1. **Registrierung war komplett kaputt** — jeder neue Nutzer bekam 400. (In diesem Branch gefixt.)
2. **Es gibt keine Monetarisierung** — der Kauf-Button für Plus/Club öffnet ein Alert mit „Dies ist eine Demo-Version"; kein IAP-SDK ist installiert; das Backend vergibt Club-Tier ohne jede Belegprüfung an jeden eingeloggten Nutzer.
3. **Es gibt keinen Deployment-Weg** — kein Dockerfile, kein Deploy-Job, keine Infrastruktur, kein Prozessmanager, kein Backup. CI baut Artefakte und hört auf.
4. **Die Rechtstexte sind Entwürfe mit `[PLATZHALTER]`** — und genau die klickt der Nutzer bei der Registrierung ab.

**Realistischer Zeitrahmen bis erste App-Store-Einreichung: 6–10 Wochen** — davon 2–4 Wochen reine Wartezeit (Apple-Enrollment, Stripe-KYC, Anwalt, TestFlight), die **sofort parallel gestartet werden muss**.

---

## 1. Was bereits funktioniert (das Fundament ist gut)

| Bereich | Status | Fundstelle |
|---|---|---|
| Sign in with Apple, echte JWKS-Signaturprüfung gegen appleid.apple.com mit iss/aud-Check | produktionsreif | `services/appleAuthService.ts:117-132` |
| Turnier-Engine: Brackets mit Seeding, Freilosen, 3.-Platz-Spiel | produktionsreif | `services/bracketService.ts` |
| Court-Booking-Transaktion mit `SELECT … FOR UPDATE`, Stripe Connect Destination Charges, 15-Min-Ablauf | produktionsreif | `services/courtBookingService.ts:26-214` |
| Stripe-Webhook-Signaturprüfung + Refund-Idempotenz unter Zeilensperre | produktionsreif | `controllers/paymentController.ts:29`, `services/paymentService.ts:355-370` |
| Membership-Entitlements serverseitig (Rabatte, Early Access, Waitlist-Priorität, Event-Gating) | produktionsreif | `routes/membership.ts:479-523` |
| Turnier-Warteliste inkl. 24-h-Claim-Fenster und Ablauf-Job | funktioniert | `services/registrationService.ts:230-343` |
| Live-Bracket über WebSocket `/ws` | funktioniert | `realtime/liveBracket.ts` |
| DSGVO-Datenexport + anonymisierende Kontolöschung (transaktional, mit Audit-Log) | Backend fertig | `routes/gdpr.ts:15, 89-140` |
| Versionierter Rechtstext-Store mit Consent-FK auf die akzeptierte Version | funktioniert | `legal_document_versions`, `controllers/legalController.ts` |
| Elo-System, Achievements, Referrals, Seasons, Streaks, Challenges, Feed | implementiert | `services/eloService.ts` u. a. |
| Apple-Icon-Assets: 1024×1024, 8-bit RGB, kein Alphakanal | Apple-konform | `apps/mobile/assets/icon.png` |
| Expo SDK 54.0.34 / RN 0.81.5 — aktueller, von Apple akzeptierter Toolchain | produktionsreif | `apps/mobile/package.json:27,53` |
| DE/EN-Übersetzungsbundles mit exakter 471/471-Key-Parität | vollständig | `src/i18n/` |
| Stripe korrekt auf Turniergebühren + Platzbuchungen beschränkt (reale Leistungen, IAP-befreit nach 3.1.3(e)) | korrekt klassifiziert | `services/paymentService.ts:44-66` |

---

## 2. Blocker — ohne diese Punkte geht nichts live

### 2.1 In diesem Branch bereits behoben

| # | Problem | Fix |
|---|---|---|
| B1 | **Registrierung ging nie durch.** Client sendet `consent_age_verification`, Validator verlangt `consent_age`; zusätzlich sind `terms_version_id` und `privacy_version_id` Pflichtfelder, die der Client nie sendet → jede Registrierung endet in 400. | `register.tsx` lädt jetzt die aktiven Rechtsdokument-Versionen über `GET /legal/terms` und `/legal/privacy` und sendet die korrekten IDs; `RegisterData` spiegelt `registerSchema` |
| B2 | **Konto-Löschung schlug immer fehl** (404) — `api.delete('/users/account')`, existierende Route ist `POST /me/delete-account`. Harte Apple-Ablehnung nach 5.1.1(v) und Art.-17-DSGVO-Verstoß. | Call korrigiert |
| B3 | **Sign in with Apple hätte in Produktion nie funktioniert** — Backend-Audience `com.turneo.app`, App liefert `de.tourneo.app` aus. | Default + `.env.example` auf `de.tourneo.app` |
| B4 | **App hieß im Store „Turneo"** (Tippfehler im Anzeigenamen). | `app.json` → „Tourneo", ebenso `APP_NAME`/`SMTP_FROM_NAME` |
| B5 | Altersprüfung rechnete mit `365.25`-Näherung — an Geburtstagsrändern falsch. | kalendergenaue `ageInYears()` |
| B11 | **Kein Melden, kein Blockieren, keine Moderation** (Guideline 1.2 + DSA). | Migration 020 + `moderationService.ts`: Melden auf Chat, Reviews, Fotos, Profilen; symmetrisches Blockieren, das Chat **und** Feed filtert; Moderations-Queue mit 24-h-Ziel; Mobile: Longpress im Chat, Menü auf dem Profil, Verwaltung blockierter Nutzer in den Einstellungen |
| B34 | Kein Graceful Shutdown, keine Prozess-Handler. | Geordnetes Draining mit 15-s-Backstop, `unhandledRejection`, `uncaughtException` |
| B35 | `/health` war ein Literal und fasste die DB nie an. | `/health` = echte Liveness, neu `/ready` mit DB-Query und 503 |
| B38 | Brute-Force-Schutz auf null Routen gemountet. | Auf `/login` und `/forgot-password` gemountet, Controller zählt Fehlversuche |
| B39 | DB-TLS akzeptierte jedes Zertifikat. | Verifikation standardmäßig an, `DB_SSL_CA`, Escape-Hatch in Produktion gesperrt |
| B45 | Support-Screen aus der App nicht erreichbar. | Aus den Einstellungen verlinkt |
| B10 | **Stripe-Checkout baute eine erfundene URL** und der Deep-Link-Handler setzte unbekannte Zustände auf `success` → bestätigte Anmeldungen ohne Zahlung. | Server erstellt jetzt eine echte **Stripe Checkout Session** (Karteneingabe, SCA/3DS, Apple Pay) für Turniere **und** Platzbuchungen; der Client rät nie mehr, sondern fragt den tatsächlichen Status über `GET /registrations/:id` ab |
| — | `DB_TABLE_PREFIX=turneo_` hätte die Fehlschreibung in jeden Tabellennamen gebacken. | korrigiert |

### 2.2 Offen — Monetarisierung (der größte Block)

| # | Problem | Fundstelle | Aufwand |
|---|---|---|---|
| B6 | **Kein IAP-SDK installiert.** Kein `expo-in-app-purchases`, kein `react-native-iap`, kein RevenueCat. Der Kauf-Button zeigt ein Alert: „In der Produktionsversion wird hier der Apple-Kaufdialog angezeigt. Dies ist eine Demo-Version." Gleichzeitig werden echte Preise beworben. → Ablehnung nach Guideline 2.1, bevor ein Reviewer überhaupt Guideline 3 erreicht. | `app/membership.tsx:69-73`, `package.json` | L |
| B7 | **Backend prüft keinen einzigen Apple-Beleg.** Die Verifikation ist eine auskommentierte Zeile — jeder eingeloggte Nutzer kann sich per POST selbst Club-Tier schenken und es wird eine gefälschte `succeeded`-Zahlungszeile geschrieben. | `routes/membership.ts:221` | L |
| B8 | **„Restore Purchases" ist ein Platzhalter-String** — bei Auto-Renewable Subscriptions von Apple zwingend verlangt. | `app/settings.tsx` | M |
| B9 | **Der komplette Membership-Client-Vertrag passt nicht zum Server** — Verb, Pfadform und Body-Felder weichen bei jedem Call ab. | `src/store/membershipStore.ts` ↔ `routes/membership.ts` | M |

> **Strategische Option:** Plus/Club aus v1 herausnehmen. Das eliminiert B6–B9 vollständig und verkürzt den Weg zur ersten Einreichung um Wochen. Turniergebühren und Platzbuchungen laufen weiter über Stripe (legitim IAP-befreit) und funktionieren seit dem Checkout-Session-Fix (B10) tatsächlich.

### 2.3 Offen — Apple-Review

| # | Problem | Fundstelle | Aufwand |
|---|---|---|---|
| B11 | **Kein Melden, kein Blockieren, keine Moderation** — bei Event-Chat, Aktivitäts-Feed, Venue-Reviews, Fotos und Profilen. Guideline 1.2 verlangt für UGC: Filter, Melden-Funktion, Blockieren, und Reaktion binnen 24 h. Zusätzlich DSA-Pflicht. | überall abwesend | L |
| B12 | **Community-Tab sind 809 Zeilen erfundene Daten** — Fake-Freunde, Fake-Teams, Fake-Rankings, `setTimeout`-Pull-to-Refresh. | `app/(tabs)/community.tsx:52-55, 252-283` | L |
| B13 | **Fake-Zahlungsschritt „Apple Pay •••• 4242"** in der Turnier-Anmeldung. | `app/event/register/[id].tsx` | M |
| B14 | **Erfundene Elo-Historie und Rang** für jeden Nutzer ohne Match-Historie. | Profil-Screens | S |
| B15 | **Kein Privacy Manifest** (`PrivacyInfo.xcprivacy` / `ios.privacyManifests`) und kein `ITSAppUsesNonExemptEncryption`. | `app.json` | S |
| B16 | **Kein EAS `projectId`, kein `owner`** in `app.json` → `eas build` hat kein Projekt, Push-Tokens können nicht ausgestellt werden. `eas init` ausführen. | `app.json` | S |
| B17 | **`eas.json` enthält `APPLE_ID_HERE` / `ASC_APP_ID_HERE` / `APPLE_TEAM_ID_HERE`** → `eas submit` läuft nicht. | `apps/mobile/eas.json` | S |
| B18 | **Kein EULA-/Datenschutz-Link auf dem Abo-Screen** — bei Auto-Renewable Subscriptions Pflicht. | `app/membership.tsx` | S |
| B19 | **Universal Links deklariert, aber kein `apple-app-site-association`** irgendwo im Repo oder unter tourneo.de. Entweder ausliefern oder `associatedDomains` entfernen. | `app.json:28-31` | S |

### 2.4 Offen — Recht (DE)

| # | Problem | Aufwand |
|---|---|---|
| B20 | **Kein brauchbares Impressum (§5 DDG).** Zwei widersprüchliche Fassungen, beide mit Platzhaltern; eine erfindet Registergericht und HRB für ein Einzelunternehmen und zitiert das aufgehobene §5 TMG. | M · **Anwalt** |
| B21 | **Die Texte, die der Nutzer bei der Registrierung akzeptiert, sind hartkodierte Platzhalter** (`[FIRMENNAME]`, `[STRASSE]`, `[PLZ] [STADT]`, `[NAME DES DSB]`) und weichen von den Backend-Dokumenten ab. Ein Consent auf einen Platzhaltertext ist wertlos. Lösung: hartkodierte Komponenten löschen, Markdown aus `GET /legal/:type` rendern — eine Quelle der Wahrheit. | M |
| B22 | **Alle Backend-Rechtstexte tragen „⚠️ ENTWURF – VOR LIVEGANG DURCH DEUTSCHEN RECHTSANWALT PRÜFEN LASSEN"** und sind mit `is_active: true` live. Empfehlung: Startup-Guard, der in Produktion die Boot-Sequenz abbricht, wenn ein aktives Dokument auf `/⚠️|ENTWURF|DRAFT|\[[A-ZÄÖÜ]+\]/` matcht. | L · **Anwalt** |
| B23 | **Keine Widerrufsbelehrung, kein Muster-Widerrufsformular** — bei Abos und bezahlten Tickets. Zusätzlich muss der Kaufbutton „Zahlungspflichtig bestellen" heißen. Ob §312g Abs.2 Nr.9 (Freizeitveranstaltung zu festem Termin) die Turniere ausnimmt, muss der Anwalt entscheiden. | M · **Anwalt** |
| B24 | **Betreiberidentität existiert nirgends als Konfiguration** — nur Platzhalter plus eine hartkodierte private `@web.de`-Adresse als Superadmin. Braucht einen validierten Operator-Config-Block, aus dem Impressum und Datenschutz-Abschnitt gerendert werden. | M |
| B25 | **Öffentliche Web-Profile zeigen Klarnamen, Stadt und Rating standardmäßig**, ohne Opt-out. `discoverable` muss auf `false` defaulten. | M |
| B26 | **Push-Tokens werden unabhängig von der Push-Einwilligung registriert.** | S |
| B27 | **Optionale Consents (Push, Personalisierung, Newsletter) erreichen den Server nie** — Fire-and-forget an eine nicht existierende Route. Ebenso ist der DSGVO-Datenexport aus der App nicht erreichbar. | M |
| B28 | Newsletter ohne Double-Opt-in, ohne serverseitige Speicherung, ohne Abmeldelink. | M |
| B29 | **Keine AVV (Art. 28 DSGVO)** mit Stripe, Apple, Firebase, Expo. Kein Verzeichnis von Verarbeitungstätigkeiten (Art. 30). | M · **[OWNER]** |
| B30 | **„Garantiertes Preisgeld" wird überall beworben, aber `prize_payouts` wird von keiner Codezeile beschrieben.** Entweder Auszahlungspipeline bauen oder das Wort „garantiert" streichen. | L |
| B31 | **Keine GlüStV-Bewertung** für Turniere mit Startgeld und Geldpreisen. Nicht selbst einschätzen. | M · **Anwalt** |
| B32 | Keine USt-/Kleinunternehmer-Behandlung, keine echte Rechnung — obwohl Rechnungsnummern erzeugt werden. Achtung: Apple ist bei IAP Kommissionär (führt USt selbst ab), bei Stripe führst du selbst ab — zwei Steuerbehandlungen in einem Produkt. | L · **Steuerberater** |

### 2.5 Offen — Betrieb

| # | Problem | Aufwand |
|---|---|---|
| B33 | **Kein Deployment-Mechanismus.** Kein Dockerfile, kein Procfile, kein `fly.toml`, kein Terraform, kein Deploy-Job, kein Prozessmanager. CI baut und hört auf. | L |
| B34 | **Kein Graceful Shutdown**, kein SIGTERM/SIGINT-Handler, kein `unhandledRejection`/`uncaughtException`-Handler → jedes Deploy killt laufende Requests. | S |
| B35 | **`/health` ist ein hartkodiertes Literal** und fasst die DB nie an; der Server bootet und bedient Traffic bewusst mit toter DB. | S |
| B36 | **Kein Error-Tracking, keine Request-IDs, keine Metriken.** Morgan-Textlogs mischen sich mit Pino-JSON. Crash-Reports der App landen in AsyncStorage und werden nie hochgeladen → null Produktions-Sichtbarkeit. | M |
| B37 | **Passwort-Reset invalidiert keine Sessions.** Refresh-Tokens sind zustandslose 30-Tage-JWTs ohne Store, ohne Rotation, ohne Revocation — Logout, Kontolöschung und Admin-Sperre beenden eine gestohlene Session nicht. | M |
| B38 | **`bruteForceProtection` ist vollständig implementiert und getestet — aber auf null Routen gemountet.** | S |
| B39 | **DB-TLS akzeptiert jedes Zertifikat** (`rejectUnauthorized: false`) in Runtime- und Migrations-Config. | S |
| B40 | **Backend-Testabdeckung 4,93 %** — null Tests für Controller, Routen, Payments oder Auth-Service. Genau die Schicht, in der B1/B2/B9/B10 entstanden sind. Contract-Tests Client↔Server hätten alle vier verhindert. | XL |
| B41 | **Kein OTA-Update, kein Force-Upgrade, kein Kill-Switch, kein Wartungsmodus.** Der erste ernste Produktionsbug ist 24–48 h lang nicht behebbar. | M |
| B42 | **SMTP-Fehlkonfiguration degradiert still zu Console-Logging**, und `email_verified` wird nirgends erzwungen → der Ausfall bleibt tagelang unsichtbar. Kein SPF/DKIM/DMARC. In Deutschland (GMX/Web.de) ist das der wahrscheinlichste Launch-Day-Killer. | M |
| B43 | **`REDIS_URL` ist optional**, aber die BullMQ-Jobs (Buchungs-Reminder, Waitlist-Ablauf, Match-Reminder) hängen daran. | S |
| B44 | **Keine echten Inhalte.** Null Venues, null Courts, null Availability-Slots im Seed; Partner-Venues zeigen auf `example.com`. Der Seed ist idempotenz-geschützt, wodurch das Demo-Event-Datum still verrottet. | M |
| B45 | **Support-Screen existiert, ist aber aus der App nicht erreichbar**; Tickets landen in einer Tabelle, über die niemand benachrichtigt wird und die kein UI anzeigt. | M |
| B46 | **DB-Zugangsdaten stehen im Klartext in `README.md:200`** — rotieren. | S · **[OWNER]** |
| B47 | **`tourneo.de` liefert an der Wurzel einen JSON-Blob.** Keine öffentliche HTML-Datenschutzerklärung zum Eintragen in App Store Connect, kein `/.well-known/`. Apple verlangt eine erreichbare Privacy-Policy-URL und eine Support-URL; Stripe prüft vor Freischaltung eines deutschen Geschäftskontos genau diese Seite. | M |

---

## 3. Branches

| Branch | Stand | Bewertung |
|---|---|---|
| `main` | aktuell, alle 12 Workflow-Runs grün | **Ungeschützt.** Die letzten drei Commits — der gesamte „Growth Platform"-Drop — wurden ohne PR und ohne Review direkt gepusht. Branch Protection aktivieren. |
| `claude/golive-checklist-live-features-iq63pf` | dieser Branch | Blocker-Fixes B1–B5 + diese Checkliste + das Live-Queue-Design |
| `claude/code-review-bug-check-9295B` | gemergt | kann gelöscht werden |
| `codex/free-tournament-ops` | **83 Dateien, +7.745 Zeilen, nie als PR eröffnet, nie durch CI** | Enthält sechs Migrationen, deren Nummern **frontal mit denen auf `main` kollidieren**. Entweder bewusst aufgeben oder rebasen und die Migrationen umnummerieren — ein blinder Merge zerstört das Schema. Vor dem Launch entscheiden. |

**CI:** genau ein Workflow (`.github/workflows/build.yml`, drei Jobs). Keine Secrets, kein Deploy-Schritt, kein EAS-Build, keine Git-Tags, keine Releases. `expo export` erzeugt ein JS-Bundle, keine `.ipa` — **grüne CI sagt null darüber aus, ob ein App-Store-Build funktioniert.**

---

## 4. Platzsuche und Live-Warteschlange — der ehrliche Stand

**Frage: Bringt die App heute etwas, um freie Plätze zu finden, mit Live-Warteschlange?**
**Antwort: Nein. Nichts davon ist live, und die Warteschlange für Plätze existiert überhaupt nicht.**

**Was existiert:**
- `court_availability`-Tabelle mit Slots (Datum, Start, Ende, Status, Preis) — `migrations/010:56-74`
- `GET /venues/:id/availability` — Slots **eines** Venues lesen — `routes/venues.ts:43-60`
- Eine produktionsreife Buchungstransaktion mit Slot-Sperre, Stripe Connect, 15-Min-Ablauf — `courtBookingService.ts:26-214`
- Ein Mobile-Screen `venue/availability/[id].tsx`, der **einmal beim Mount lädt** und Pull-to-Refresh anbietet

**Was fehlt:**
- **Nichts ist live.** Kein Polling, kein Socket, keine Invalidierung auf dem Availability-Screen. Der WebSocket-Hub existiert, ist aber ausschließlich für Brackets — die App verbindet sich für Plätze nie.
- **Keine Platz-Warteschlange in irgendeiner Form.** Kein Table, kein Service, keine Route, kein Screen. (Gegrept: `slot_waitlist|court_waitlist|notify_me|watch_slot|availability_alert` — null Treffer im gesamten Repo.) Die vorhandene Warteliste betrifft **Turnierplätze**, nicht Courts.
- **Keine venue-übergreifende Suche.** „Zeig mir freie Plätze in meiner Nähe" ist auf der heutigen API nicht baubar — man kann nur Venue für Venue abfragen.
- **Keine Benachrichtigung, wenn ein Platz frei wird.**
- **Keine Datenquelle.** `playtomicService.ts` ist **keine** Verfügbarkeits-Integration — es mappt Playtomic-Skill-Level 0–7 auf Elo-Startwerte und verwaltet Screenshot-Verifikation. Es macht **null HTTP-Calls**. Alle Slots müssen heute von einem Tourneo-Superadmin per JSON-API eingetragen werden — und das Admin-Dashboard hat dafür nicht mal ein Formular.

**Zwei Datenintegritäts-Probleme, die vor jeder Warteschlange gelöst sein müssen:**
- **Kein Unique-Constraint auf `court_availability`** — ein erneuter Lauf der Slot-Generierung dupliziert jeden Slot. Zwei Zeilen für einen physischen Court bedeuten später zwei unabhängige Warteschlangen, zwei Holds, zwei Buchungen.
- **Zeitzonen sind falsch.** Slot-Zeiten sind naiv, die DB-Verbindung ist auf UTC festgenagelt — in CEST ist jeder Claim-Countdown zwei Stunden daneben.

### Was inzwischen gebaut ist

**Phase 0 und Phase 1 sind implementiert.** Der vollständige Entwurf steht in [`docs/LIVE_COURT_QUEUE.md`](docs/LIVE_COURT_QUEUE.md).

- **Migration 018** — `venues.timezone`, absolute Zeitstempel (`starts_at_utc`), `source`/`confidence`, Dedupe plus Unique-Key über eine generierte Spalte, `held`-Status und Hold-Spalten. `utils/slotTime.ts` rechnet über die Venue-Zeitzone und behandelt beide Sommerzeit-Grenzen explizit.
- **Migration 019** — `slot_waitlist`, `slot_offers`, `notification_prefs`. Zwei Invarianten stehen im Schema statt im Code: ein aktiver Eintrag pro Nutzer und Slot, ein offenes Angebot pro Slot.
- **`slotQueueService.ts`** — die Slot-Zeile ist der Mutex für die ganze Warteschlange; ein frei werdender Platz geht **innerhalb** der stornierenden Transaktion direkt auf `held`. Alle drei Freigabepfade (Stornierung, Zahlungsausfall, 15-Min-Ablauf) hängen daran.
- **`realtime/hub.ts`** — topic-basiert (`venue:`, `slot:`, `city:`, `user:`, `event:`) mit JWT-Auth, Sequenznummern, Reconnect-Backfill und optionalem Redis-Fan-out.
- **`slotNotifier.ts`** — Push mit Ruhezeiten und Dedupe. iOS hat keinen Hintergrund-Socket, deshalb: Vordergrund = Socket, Hintergrund = Push.
- **Mobile** — `RealtimeProvider`, Live-Availability-Screen mit Warteschlangen-Sheet, Claim-Screen mit servergestütztem Countdown, Warteschlangen-Sektion in den Buchungen, Push-Deeplink inklusive Cold-Start, und der neue Screen `app/courts/index.tsx`, dessen Fehlen die ganze Platz-Säule unerreichbar machte.

**Offen bleibt:** die Datenquelle. Slots müssen weiterhin per API eingetragen werden — das Admin-Dashboard hat dafür kein Formular. Phase 2 (venue-übergreifende Suche, iCal-Import) und Phase 3 (Club-Portal, Platz-Alerts) sind nicht gebaut.

---

## 5. Reihenfolge

### Jetzt sofort starten — lange Vorlaufzeiten **[OWNER]**

Diese Punkte laufen parallel zur Entwicklung und sind der eigentliche kritische Pfad:

- [ ] **Rechtsform entscheiden: Einzelunternehmen oder UG/GmbH.** Das ist die Wurzelentscheidung — sie bestimmt Apple-Enrollment-Typ, Impressum, Stripe-KYC, Verkäufername im Store, Rechnungen und USt. Alles andere hängt davon ab.
- [ ] **Apple Developer Program** (99 USD/Jahr). Organization-Enrollment braucht D-U-N-S + eingetragene Gesellschaft (1–4 Wochen). Als Einzelunternehmen erscheint dein Klarname als Verkäufer im Store.
- [ ] **Paid Applications Agreement** + Bankverbindung + Steuerformulare. Bis das „Active" ist, kann **kein Geld fließen** — blockiert Plus/Club auch dann, wenn StoreKit fertig ist.
- [ ] **Anwalt beauftragen**: AGB, Datenschutzerklärung, Impressum, Widerrufsbelehrung, GlüStV-Gutachten.
- [ ] **Stripe Live-Aktivierung + KYC + Connect-Plattformprofil** inkl. expliziter Antwort, wer bei Platzbuchungen das Chargeback-Risiko trägt.
- [ ] **Markenrecherche „Tourneo"** (DE/EU) + Namensverfügbarkeit im App Store.
- [ ] **Steuerberater**: USt auf Startgelder/Abos/Preisgelder, Gewerbeanmeldung.
- [ ] Launch-Stadt, Launch-Venue und erstes Turnierdatum festlegen.

### Sprint 1 — Grundlagen (~2 Wochen)

- [ ] Entscheidung: **Plus/Club in v1 oder nicht?** (Streichen entfernt B6–B9 komplett)
- [x] ~~Dockerfile + Produktions-Migrations-Runner (`migrate:prod`) + Image-Build in CI~~ — offen: Registry, Deploy-Ziel, Secrets **[OWNER]**
- [ ] Graceful Shutdown, echter `/health` mit DB-Ping, Prozess-Handler (B34, B35)
- [ ] Sentry im Backend und in der App, Request-IDs, einheitliches Logging (B36)
- [ ] `REDIS_URL` und SMTP in `validateEnv()` verpflichtend machen (B42, B43)
- [ ] SPF/DKIM/DMARC setzen, gegen gmx.de / web.de / gmail.com testen (B42)
- [ ] Refresh-Token-Store mit Revocation; `bruteForceProtection` mounten (B37, B38)
- [ ] DB-Credentials aus `README.md` rotieren (B46)
- [ ] Branch Protection auf `main`; `codex/free-tournament-ops` entscheiden

### Sprint 2 — Apple-Pflichtprogramm (~2–3 Wochen)

- [ ] Melden + Blockieren + Moderations-Queue (B11) — nicht verhandelbar
- [ ] Community-Tab: Fake-Daten raus, echte Endpoints dran (B12)
- [ ] Fake-Apple-Pay-Schritt entfernen, echtes Stripe PaymentSheet mit SCA/3DS (B13, B10)
- [ ] Erfundene Elo-Historie entfernen (B14)
- [ ] `eas init`, echte Submit-Credentials, Privacy Manifest, Verschlüsselungserklärung (B15–B17)
- [ ] Push-Architektur entscheiden: Expo-Token über `exp.host` **oder** native APNs-Token über FCM — heute werden Expo-Tokens durch Firebase geschickt, das kann nie funktionieren
- [ ] Notification-Tap-Handling + Deep Links inkl. Cold-Start
- [ ] Toter Code: 11 Screens ohne Einstiegspunkt anbinden oder entfernen
- [ ] i18n: nur 11 von 44 Screens nutzen `t()` — auf Englisch bleibt die App größtenteils deutsch

### Sprint 3 — Recht + Web (~2 Wochen)

- [ ] Anwaltstexte einpflegen, hartkodierte Mobile-Texte löschen, alles aus `GET /legal/:type` rendern (B21, B22)
- [ ] Operator-Config + Impressum daraus rendern (B24)
- [ ] Widerrufsbelehrung + „Zahlungspflichtig bestellen" (B23)
- [ ] Consent-Endpoint + Datenexport in der App erreichbar machen (B27)
- [ ] `discoverable` auf `false` defaulten (B25), Push-Consent respektieren (B26)
- [ ] **Öffentliche Website unter tourneo.de**: Impressum, Datenschutz, AGB, Widerruf, Support, `/.well-known/apple-app-site-association` (B47) — schaltet drei Pflichtfelder in App Store Connect frei *und* ist Voraussetzung für die Stripe-Freischaltung
- [ ] Support-Screen verlinken, Ticket-Benachrichtigung, Admin-UI (B45)

### Sprint 4 — Inhalte + Einreichung (~2 Wochen)

- [ ] Echte Venues, Courts und Slots eintragen — dafür braucht es zuerst ein Admin-UI (B44)
- [ ] `example.com`-Partner-Venues löschen
- [ ] Seed trennen: Recht + Admin in Produktion, Demo-Inhalte nie
- [ ] App Store Connect: App-Record, Altersfreigabe, Privacy Labels, Screenshots in Pflichtgrößen (die 390×844-Simulator-Captures in `docs/screenshots/` reichen nicht — 6.9" = 1290×2796 nötig), Metadaten DE+EN, Demo-Account, Review-Notes mit Erklärung der Stripe-vs-IAP-Trennung
- [ ] OTA-Kanal, `GET /app-config` mit `minimum_version` und Wartungs-Kill-Switch (B41)
- [ ] TestFlight intern → extern, **mindestens zwei Runden mit echten Padel-Spielern**
- [ ] Backup-Zeitplan **plus eine getestete Wiederherstellung**
- [ ] Incident-Runbook inkl. Art.-33-72-Stunden-Meldeweg

---

## 6. Die zwei Dinge, die am Launch-Tag am ehesten weh tun

1. **E-Mails werden still nicht zugestellt.** Es scheitert unsichtbar, es scheitert am ersten Schritt des Funnels, kein Codepfad erzwingt `email_verified`, kein Alert existiert — und deutsche Consumer-Postfächer sind das härteste denkbare Publikum für eine neue, nicht authentifizierte Domain. Jeder Nutzer strandet, und du erfährst es von einem Bekannten statt von einem Dashboard.

2. **Du kannst nichts reparieren.** Kein OTA, kein Force-Upgrade, kein Kill-Switch, kein Rollback, keine Crash-Sichtbarkeit. Bei der dokumentierten Fehlerdichte wird der erste ernste Bug — wahrscheinlich der Payment-Deep-Link, der auf `success` defaultet — 24–48 Stunden lang gratis Anmeldungen verschenken, während du zusiehst.

Beides ist in Sprint 1 mit wenigen Tagen Arbeit erledigt. Beides wird typischerweise übersprungen.
