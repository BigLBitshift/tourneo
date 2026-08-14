# Tourneo Live Court Queue — Implementation Design

> **Kurzfassung (DE)** — siehe auch [`GO_LIVE_CHECKLIST.md`](../GO_LIVE_CHECKLIST.md) Abschnitt 4.
>
> **Das Ziel:** „Platz belegt? Stell dich an. Wir halten ihn 10 Minuten für dich, sobald er frei wird."
>
> **Der Kerngedanke:** Die Buchungstransaktion in `courtBookingService.ts:30-40` nimmt bereits ein
> `SELECT … FOR UPDATE` auf die `court_availability`-Zeile. **Diese Zeile wird der Mutex für die
> gesamte Warteschlange dieses Slots.** Jede Queue-Mutation — anstellen, verlassen, anbieten,
> sichern, ablehnen, ablaufen — beginnt mit derselben Sperre. Ein Lock, immer zuerst genommen,
> kein Deadlock-Puzzle, kein `SKIP LOCKED` (das MariaDB erst ab 10.6 kann).
>
> **Der zweite Kerngedanke:** Ein frei werdender Slot geht **innerhalb der stornierenden Transaktion**
> direkt von `booked` nach `held` — niemals über `available`. Sonst gewinnt ein Pull-to-Refresh das
> Rennen gegen die Warteschlange, und das Feature ist beim ersten Mal eine Lüge gegenüber einem
> zahlenden Mitglied.
>
> **Woher die Daten kommen (der ehrliche Teil, §5):** Playtomic scrapen ist keine Option —
> ToS-Bruch, in Deutschland zusätzlich über §87b UrhG und §4 UWG angreifbar. Das einzige
> Live-Signal, das Tourneo am Tag eins wirklich besitzt, sind **die eigenen Buchungen**: jede
> Stornierung, jeder Zahlungsausfall, jeder 15-Minuten-Ablauf macht einen Platz frei — zu 100 %
> korrekt, ohne einen einzigen Partner. Klein am Anfang, aber jedes dieser Ereignisse verpufft
> heute lautlos. Dazu: Grundbestand über den vorhandenen `generateRecurring`-Generator seeden
> (10–20 Venues × ein JSON-POST = ein Quartal Abdeckung an einem Ops-Tag), iCal/CSV-Import für
> Clubs, und die `source`-Spalte, damit die UI die Wahrheit sagen kann („Voraussichtlich frei —
> beim Club anfragen" statt eines gefälschten „Buchen"-Buttons).
>
> **Und der strategisch wertvollste Teil:** `slot_watches` auch für Venues **ohne** Bestand
> aufzeichnen. Sechs Wochen später gehst du in den Club mit: *„37 Spieler haben diese Woche auf
> einen Platz bei euch gewartet — hier ist euer Portal-Login."* Das ist der Pitch, der Clubs
> konvertiert. Die Watch-Tabelle ist strategisch wertvoller als die Queue-Tabelle.
>
> **Zeitplan:** Phase 0 (Datenintegrität + Zeitzonen) ~1 Woche · Phase 1 (die Warteschlange,
> MVP-fähig) ~3 Wochen · Phase 2 (venue-übergreifende Suche) ~2 Wochen · Phase 3 (Club-Portal,
> Alerts, Redis-Skalierung) ~2–3 Wochen.
>
> **Phase 0 ist nicht optional.** Ohne Unique-Constraint auf `court_availability` bedeuten zwei
> duplizierte Zeilen für einen physischen Court zwei unabhängige Warteschlangen, zwei Holds und
> zwei Buchungen. Und ein Claim-Countdown, der über `combineDateTime` läuft, ist in CEST zwei
> Stunden falsch.

---


*Grounded in a read of `courtAvailabilityService.ts`, `courtBookingService.ts`, `playNowService.ts`, `notificationService.ts`, `realtime/liveBracket.ts`, `routes/venues.ts`, `routes/bookings.ts`, migrations 001/010/015/016/017, `jobs/index.ts`, `middleware/auth.ts`, `config/database.ts`, `venueController.ts`, and the mobile screens `venue/availability/[id].tsx`, `play-now.tsx`, `bookings.tsx`, `useLiveBracket.ts`, `bookingStore.ts`, `api/client.ts`.*

---

## 0. The one architectural idea

The existing booking transaction already does the hard part. `CourtBookingService.bookSlot` (`apps/backend/src/services/courtBookingService.ts:30-40`) takes `SELECT … FOR UPDATE` on the `court_availability` row before touching anything. **Make that row the mutex for the entire queue of that slot.** Every queue mutation — join, leave, offer, claim, decline, expire — opens with the same `SELECT … FROM court_availability WHERE id = ? FOR UPDATE`.

Consequences, all good:
- No `SKIP LOCKED` needed (MariaDB only has it from 10.6 — don't take that dependency).
- No gap locks on `slot_waitlist`, no deadlock ordering puzzle: there is exactly one lock, always taken first.
- It composes with code that already exists. `bookSlot:37` checks `slot.status !== 'available'` and `playNowService.ts:113` checks the same — so the moment we add a `'held'` status value, **both the direct-book path and the Spiel-jetzt auto-book path become queue-aware for free**, with zero edits.

The second idea: **free-to-held must be atomic with the cancellation**. If you release to `'available'` and *then* offer, a pull-to-refresher wins the race and the queue is a lie. So `onSlotFreed()` runs *inside* the caller's existing transaction.

---

## 1. Data model

Two migrations, because Phase 0 must ship before any queue is trustworthy.

### 1.1 Migration `018_slot_integrity_and_time.ts` (Phase 0 — prerequisites)

A queue on top of duplicated slot rows means two queues on one physical court. And a claim countdown computed by `combineDateTime` (`courtBookingService.ts:323-327`) is 2 hours wrong in CEST. Both must die first.

```ts
// apps/backend/src/migrations/018_slot_integrity_and_time.ts
import { Knex } from 'knex';
const PREFIX = process.env.DB_TABLE_PREFIX || 'tourneo_';
const t = (n: string) => `${PREFIX}${n}`;

export async function up(knex: Knex): Promise<void> {
  // 1) Venue timezone — no code anywhere declares Europe/Berlin today.
  await knex.schema.alterTable(t('venues'), (table) => {
    table.string('timezone', 64).notNullable().defaultTo('Europe/Berlin');
  });

  // 2) Absolute instants + provenance + a broadcast sequence counter.
  await knex.schema.alterTable(t('court_availability'), (table) => {
    table.datetime('starts_at_utc').nullable();
    table.datetime('ends_at_utc').nullable();
    table.enum('source', ['venue', 'import', 'assumed', 'crowd', 'admin'])
      .notNullable().defaultTo('admin');
    table.tinyint('confidence').notNullable().defaultTo(100);   // 0-100
    table.enum('sport', ['padel', 'tennis', 'multi']).notNullable().defaultTo('padel');
    table.integer('version').unsigned().notNullable().defaultTo(0);
    table.index(['starts_at_utc', 'status'], `${t('court_availability')}_instant_idx`);
  });

  // 3) DEDUPE before the unique key. NOT EXISTS guard is load-bearing:
  //    court_bookings.slot_id is ON DELETE CASCADE (migration 015:29), so
  //    deleting a duplicated slot that carries a live booking would silently
  //    destroy the booking.
  await knex.raw(`
    DELETE ca FROM \`${t('court_availability')}\` ca
    JOIN (
      SELECT MIN(id) AS keep_id, venue_id, COALESCE(court_id,0) AS ck, slot_date, slot_start
      FROM \`${t('court_availability')}\`
      GROUP BY venue_id, ck, slot_date, slot_start
      HAVING COUNT(*) > 1
    ) d ON d.venue_id = ca.venue_id
       AND COALESCE(ca.court_id,0) = d.ck
       AND ca.slot_date = d.slot_date
       AND ca.slot_start = d.slot_start
    WHERE ca.id <> d.keep_id
      AND NOT EXISTS (
        SELECT 1 FROM \`${t('court_bookings')}\` b
        WHERE b.slot_id = ca.id AND b.status <> 'cancelled'
      )
  `);

  // 4) MySQL/MariaDB treat NULLs as distinct in UNIQUE, and court_id is
  //    nullable (010:60-61) with generateRecurring writing null by default
  //    (courtAvailabilityService.ts:181). A plain UNIQUE would not protect
  //    venue-level slots. Use a STORED generated column — the same trick the
  //    repo already needed in 013_waitlist_position_unique.ts.
  await knex.raw(`
    ALTER TABLE \`${t('court_availability')}\`
      ADD COLUMN court_key BIGINT UNSIGNED AS (COALESCE(court_id, 0)) STORED,
      ADD UNIQUE KEY \`${t('court_availability')}_slot_uq\`
          (venue_id, court_key, slot_date, slot_start)
  `);

  // 5) Hold state for the claim window.
  await knex.raw(`
    ALTER TABLE \`${t('court_availability')}\`
    MODIFY COLUMN status ENUM('available','held','booked','blocked')
      NOT NULL DEFAULT 'available'
  `);
  await knex.schema.alterTable(t('court_availability'), (table) => {
    table.bigInteger('held_for_user_id').unsigned().nullable()
      .references('id').inTable(t('users')).onDelete('SET NULL');
    table.bigInteger('hold_offer_id').unsigned().nullable();      // FK added in 019
    table.datetime('hold_expires_at').nullable();
    table.index(['status', 'hold_expires_at'], `${t('court_availability')}_hold_idx`);
  });
}
```

**Backfill `starts_at_utc` in Node, not SQL.** `CONVERT_TZ(..., 'Europe/Berlin', '+00:00')` returns `NULL` unless the MySQL timezone tables were loaded via `mysql_tzinfo_to_sql` — a classic silent production failure. Ship a one-shot script `apps/backend/src/scripts/backfillSlotInstants.ts` that pages 5000 rows at a time and computes the offset with `Intl.DateTimeFormat(..., { timeZone: tz, timeZoneName: 'longOffset' })`. Add a boot assertion in `apps/backend/src/index.ts` that logs loudly if `SELECT CONVERT_TZ(NOW(),'Europe/Berlin','+00:00') IS NULL`, then never rely on it in queries.

Code changes riding along in Phase 0:
- `courtAvailabilityService.upsertSlot` and `generateRecurring` compute `starts_at_utc`/`ends_at_utc` and `sport` (from `courts.court_type`, joined once) at write time; convert `generateRecurring:195` to `INSERT … ON DUPLICATE KEY UPDATE` now that the unique key exists.
- `combineDateTime` (`courtBookingService.ts:323`) is deleted; `:41-44` and `:251-259` read `slot.starts_at_utc` directly.
- `apps/backend/src/jobs/bookingReminder.ts:13-27` drops the `TIMESTAMP(slot_date, slot_start)` raw comparison for `WHERE starts_at_utc BETWEEN ? AND ?`.

### 1.2 Migration `019_live_slot_queue.ts` (Phase 1 — the feature)

```ts
// A) The queue on a specific slot.
await knex.schema.createTable(t('slot_waitlist'), (table) => {
  table.bigIncrements('id').primary();
  table.bigInteger('slot_id').unsigned().notNullable()
    .references('id').inTable(t('court_availability')).onDelete('CASCADE');
  table.bigInteger('user_id').unsigned().notNullable()
    .references('id').inTable(t('users')).onDelete('CASCADE');
  // Denormalised so "my queue" and the club-facing demand report never
  // need a 3-table join.
  table.bigInteger('venue_id').unsigned().notNullable()
    .references('id').inTable(t('venues')).onDelete('CASCADE');
  table.datetime('slot_starts_at_utc').notNullable();      // denorm for sorting "my queue"
  table.integer('position').notNullable();                 // FIFO seq within the slot
  // Same denormalisation trick as registrations.membership_tier_at_registration
  // so a lapsed membership cannot retroactively reorder a live queue.
  table.enum('membership_tier_at_join', ['free','plus','club']).notNullable().defaultTo('free');
  table.enum('status', ['queued','offered','claimed','declined','expired','cancelled','superseded'])
    .notNullable().defaultTo('queued');
  table.boolean('auto_claim').notNullable().defaultTo(false);   // Club perk
  table.bigInteger('watch_id').unsigned().nullable();           // set when auto-queued from a watch
  table.datetime('joined_at').notNullable();
  table.datetime('resolved_at').nullable();
  table.datetime('created_at').notNullable();
  table.datetime('updated_at').notNullable();
  table.unique(['slot_id','user_id'], `${t('slot_waitlist')}_slot_user_uq`);
  table.index(['slot_id','status','position'], `${t('slot_waitlist')}_queue_idx`);
  table.index(['user_id','status'], `${t('slot_waitlist')}_user_idx`);
  table.index(['venue_id','joined_at'], `${t('slot_waitlist')}_demand_idx`);
});

// B) One row per claim window. Separate from slot_waitlist because the
//    sweeper needs an (status, expires_at) index it can scan cheaply, and
//    because cascade depth / response latency are the anti-abuse signals.
await knex.schema.createTable(t('slot_offers'), (table) => {
  table.bigIncrements('id').primary();
  table.bigInteger('slot_id').unsigned().notNullable()
    .references('id').inTable(t('court_availability')).onDelete('CASCADE');
  table.bigInteger('waitlist_id').unsigned().notNullable()
    .references('id').inTable(t('slot_waitlist')).onDelete('CASCADE');
  table.bigInteger('user_id').unsigned().notNullable()
    .references('id').inTable(t('users')).onDelete('CASCADE');
  table.enum('status', ['pending','claimed','declined','expired','revoked'])
    .notNullable().defaultTo('pending');
  table.datetime('offered_at').notNullable();
  table.datetime('expires_at').notNullable();
  table.datetime('responded_at').nullable();
  table.smallint('cascade_depth').notNullable().defaultTo(0);   // how many passed before
  table.bigInteger('booking_id').unsigned().nullable()
    .references('id').inTable(t('court_bookings')).onDelete('SET NULL');
  table.datetime('created_at').notNullable();
  table.datetime('updated_at').notNullable();
  table.unique(['waitlist_id'], `${t('slot_offers')}_entry_uq`);   // one offer per entry
  table.index(['status','expires_at'], `${t('slot_offers')}_sweep_idx`);
  table.index(['user_id','offered_at'], `${t('slot_offers')}_abuse_idx`);
});

// C) Standing "notify me" subscriptions — a FILTER, not a slot. This is what
//    makes "zeigt was frei wird" work when nothing is booked yet, and it is
//    the single most valuable table in the design: every row is a signed
//    sales lead for a venue that is not yet a partner.
await knex.schema.createTable(t('slot_watches'), (table) => {
  table.bigIncrements('id').primary();
  table.bigInteger('user_id').unsigned().notNullable()
    .references('id').inTable(t('users')).onDelete('CASCADE');
  table.bigInteger('venue_id').unsigned().nullable()
    .references('id').inTable(t('venues')).onDelete('CASCADE');   // null = geo watch
  table.decimal('latitude', 10, 7).nullable();
  table.decimal('longitude', 10, 7).nullable();
  table.smallint('radius_km').nullable();
  table.date('date_from').notNullable();
  table.date('date_to').notNullable();
  table.time('time_from').notNullable().defaultTo('17:00:00');
  table.time('time_to').notNullable().defaultTo('22:00:00');
  table.integer('weekday_mask').notNullable().defaultTo(127);     // same bitmask as pricing_rules
  table.enum('sport', ['padel','tennis','any']).notNullable().defaultTo('padel');
  table.boolean('indoor_only').notNullable().defaultTo(false);
  table.integer('max_price_cents').nullable();
  table.smallint('min_duration_minutes').nullable();
  table.boolean('auto_queue').notNullable().defaultTo(true);      // auto-join the freed slot's queue
  table.boolean('is_active').notNullable().defaultTo(true);
  table.datetime('last_notified_at').nullable();
  table.integer('hit_count').notNullable().defaultTo(0);
  table.datetime('created_at').notNullable();
  table.datetime('updated_at').notNullable();
  table.index(['is_active','venue_id'], `${t('slot_watches')}_venue_idx`);
  table.index(['user_id','is_active'], `${t('slot_watches')}_user_idx`);
  table.index(['is_active','date_from','date_to'], `${t('slot_watches')}_window_idx`);
});

// D) Quiet hours. There is no notification-preferences table in the repo at all.
await knex.schema.createTable(t('notification_prefs'), (table) => {
  table.bigIncrements('id').primary();
  table.bigInteger('user_id').unsigned().notNullable().unique()
    .references('id').inTable(t('users')).onDelete('CASCADE');
  table.string('timezone', 64).notNullable().defaultTo('Europe/Berlin');
  table.time('quiet_hours_start').notNullable().defaultTo('22:00:00');
  table.time('quiet_hours_end').notNullable().defaultTo('07:00:00');
  table.boolean('slot_alerts_enabled').notNullable().defaultTo(true);
  table.boolean('pause_offers_during_quiet_hours').notNullable().defaultTo(false);
  table.smallint('max_slot_alerts_per_day').notNullable().defaultTo(5);
  table.datetime('created_at').notNullable();
  table.datetime('updated_at').notNullable();
});

// E) Notification type widening + idempotency key.
await knex.raw(`
  ALTER TABLE \`${t('notifications')}\`
  MODIFY COLUMN type ENUM(
    'registration_confirmed','event_published','waitlist_promoted',
    'event_reminder_1d','event_reminder_1h','checkin_available',
    'match_upcoming','result_entered','tournament_completed',
    'prize_available','membership_renewed','general',
    'slot_offer','slot_offer_expired','slot_watch_hit','slot_queue_joined'
  ) NOT NULL DEFAULT 'general'
`);
await knex.schema.alterTable(t('notifications'), (table) => {
  table.string('dedupe_key', 120).nullable();
  table.unique(['dedupe_key'], `${t('notifications')}_dedupe_uq`);
});

// F) Close the FK opened in 018.
await knex.raw(`
  ALTER TABLE \`${t('court_availability')}\`
  ADD CONSTRAINT \`${t('court_availability')}_hold_offer_fk\`
  FOREIGN KEY (hold_offer_id) REFERENCES \`${t('slot_offers')}\`(id) ON DELETE SET NULL
`);
```

**Tables extended rather than duplicated:** `court_availability` (hold state, UTC instants, provenance), `court_bookings` (untouched — claims produce identical rows), `notifications` + `push_tokens` (existing FCM plumbing, `notificationService.ts:90-147`), `memberships` (tier lookup, same query as `courtBookingService.ts:242-246`), `pricing_rules` (already read by `generateRecurring:139-143`), `venues`/`courts` (geo + `court_type` for the search join).

---

## 2. Realtime transport

### 2.1 Why WebSocket here, not SSE or polling

1. **It already exists and already works.** `apps/backend/src/realtime/liveBracket.ts` is mounted on the shared HTTP server (`index.ts:139`), so `/ws` needs no new port, no new TLS cert, no new reverse-proxy rule. `apps/mobile/src/hooks/useLiveBracket.ts:42` proves the RN client path works in production. Zero new dependencies on either side.
2. **RN has `WebSocket` as a global; it does not have `EventSource`.** SSE in Expo means adding `react-native-sse` and a polyfill, and its reconnect/`Last-Event-ID` handling is weaker than what we'd write ourselves anyway.
3. **Topic sets change constantly.** The user scrolls the day picker, switches venue, opens a slot sheet. Over ws that's one 80-byte frame. Over SSE every filter change is a connection teardown + TCP + TLS handshake. One socket multiplexes `venue:12` + `slot:98765` + `user:42` + `city:muenchen`.
4. **The latency budget is real.** A freed slot must reach the phone in <2s or the "live queue" claim is false advertising. Polling at that cadence against `GET /venues/:id/availability` is a DoS on your own DB; polling at 30s means the queue's whole premise ("I saw it the instant it opened") is fiction.
5. Bidirectionality is used for exactly two things: topic management and the app-level heartbeat. **Claims stay on REST** — they must be idempotent, retriable, and pass through `authenticate` + rate limiting + `errorHandler`. Never put a money-adjacent mutation on a socket.

### 2.2 New module: `apps/backend/src/realtime/hub.ts`

`liveBracket.ts` becomes a 6-line shim so `bracketService.ts:674-675` never changes:

```ts
// apps/backend/src/realtime/liveBracket.ts (after)
export { initHub as initLiveBracket } from './hub';
export const broadcastBracketUpdate = (eventId: number) =>
  publish(`event:${eventId}`, 'bracket_update', { event_id: eventId });
```

**Protocol** (JSON over `wss://…/ws?token=<access_jwt>`):

```jsonc
// client → server
{ "type":"subscribe",   "topics":["venue:12","slot:98765"], "since": 41221 }
{ "type":"unsubscribe", "topics":["slot:98765"] }
{ "type":"auth",        "token":"<new access jwt>" }   // rotate without reconnect
{ "type":"ping" }

// server → client
{ "type":"subscribed", "topics":["venue:12"], "seq":41240 }
{ "type":"resync",     "topics":["venue:12"], "reason":"gap" }   // buffer overflowed → REST refetch
{ "type":"pong", "ts":"2026-08-14T18:22:03.114Z" }
{ "type":"event", "topic":"venue:12", "seq":41241,
  "ts":"2026-08-14T18:22:04.902Z", "event":"slot_freed",
  "payload":{ "slot_id":98765, "court_id":41, "starts_at_utc":"2026-08-14T17:00:00Z",
              "slot_start":"19:00:00", "slot_end":"20:30:00",
              "price_cents":2800, "queue_length":4, "source":"venue" } }
{ "type":"error", "code":"TOPIC_FORBIDDEN", "topic":"user:99" }
```

Event names: `slot_freed`, `slot_held`, `slot_booked`, `slot_blocked`, `slot_added`, `queue_changed` (length only), and on `user:<id>` only: `offer_created`, `offer_expiring`, `offer_expired`, `position_changed`.

**Topic namespaces and authorization:**

| Topic | Auth | Payload rule |
|---|---|---|
| `venue:<id>` | anonymous OK | public slot state only — never a user id |
| `city:<slug>` | anonymous OK | same, plus `venue_id`/`distance` |
| `slot:<id>` | anonymous OK | public state + `queue_length` |
| `user:<id>` | **JWT required, `id` must equal `req.user.userId`** | offers, positions |

Auth on connect: parse `?token=` and run the same `jwt.verify(token, env.jwt.accessSecret)` used at `middleware/auth.ts:32`. Query param rather than an `Authorization` header because RN's `WebSocket` header support is unreliable on iOS; mitigate by (a) access tokens being short-lived, (b) never logging the raw URL — `utils/logger.ts` must redact `token=`. Anonymous sockets are allowed and get public topics only; a `subscribe` to `user:*` without a matching JWT gets `{type:'error',code:'TOPIC_FORBIDDEN'}` and is otherwise ignored (never close the socket — a hostile client would just reconnect).

**Backfill / reconnect.** Per-topic monotonic `seq` plus an in-memory ring buffer of the last 200 events (or 5 minutes, whichever is smaller) per topic. On `subscribe` with `since`:
- `since` present and inside the buffer → replay the missed frames, then `subscribed`.
- `since` older than the buffer, or absent → `{type:'resync'}`, and the client does its normal REST refetch. This is the same "socket says *something* changed, REST is the source of truth" philosophy already documented at `liveBracket.ts:14-17`, just with a correctness guarantee bolted on.

**Abuse guards** (extending the 20-subscription cap at `liveBracket.ts:47`): max 40 topics/socket, max 20 frames/sec/socket (drop + warn), max 5 concurrent sockets per authenticated user, 64 KB max frame, server-side `isAlive` heartbeat terminating sockets that miss two 30s pings.

**Scaling.** In-process today, exactly as the file's own note says. The adapter:

```ts
// hub.ts
export async function publish(topic: string, event: string, payload: unknown) {
  const seq = redis ? await redis.incr(`rt:seq:${topic}`) : nextLocalSeq(topic);
  const frame = { type: 'event', topic, seq, ts: new Date().toISOString(), event, payload };
  deliverLocal(frame);                                   // always
  if (redis) await redis.publish('tourneo:rt', JSON.stringify(frame));
}
```
On boot, when `redis` is non-null (`config/redis.ts` already exports `null` when `REDIS_URL` is unset), `SUBSCRIBE tourneo:rt` and `deliverLocal` anything not originated by this instance (tag frames with an instance id). Sequence numbers come from `INCR` so they stay globally monotonic and the backfill logic is unchanged. Single-instance dev keeps working with zero config, matching how `jobs/index.ts:101-108` already degrades.

**Publish after commit, never inside.** Services collect events into a per-transaction outbox array and flush in a `.then()` after `db.transaction` resolves. Publishing inside a transaction broadcasts state that can roll back — with Redis fan-out that error is unrecoverable.

### 2.3 Mobile client

New: `apps/mobile/src/realtime/RealtimeProvider.tsx` + `useTopic(topic)`. **One app-wide socket** in a provider, not per-screen like `useLiveBracket` — three screens each opening their own socket is three TCP connections and three reconnect storms.

- **Reconnect**: capped exponential backoff with jitter — `min(30s, 1s * 2^n) * (0.5 + Math.random()*0.5)`. `useLiveBracket.ts:78-83` has the backoff but no jitter; after a deploy every client reconnects on the same tick.
- **AppState**: on `background`, start a 20s grace timer, then close cleanly. On `active`, if `lastBackgroundedAt` > 20s ago, force a fresh connect and `subscribe` with `since: lastSeq` per topic.
- **The half-open socket bug** (the #1 RN ws defect): after foregrounding, `socket.readyState` frequently reports `OPEN` while the underlying TCP is dead. Always send a `ping` on foreground and treat no `pong` within 3s as dead → `socket.close()` → reconnect. Never trust `readyState` across a background transition.
- **iOS constraints, stated plainly**: there is no background WebSocket on iOS. Sockets die within ~30s of suspension and cannot be revived from the background. Therefore the architecture is exactly: **foreground = WebSocket, background = push.** Everything in §4 exists because of this sentence.
- **Belt and braces**: keep a `useFocusEffect` refetch + a 30s `AppState`-gated poll on the availability screen even when the socket is connected — identical to the pattern at `event/waitlist/[id].tsx:51-55` and `useLiveBracket`'s own fallback. The socket is an optimisation; the REST endpoint is the truth.

---

## 3. Queue mechanics

### 3.1 Ordering — one SQL fragment, three call sites

The audit found the exact bug this prevents: `bracketService.ts:832-837` displays FIFO order while `registrationService.ts:262-270` promotes tier-first. Extract it so they cannot drift:

```ts
// apps/backend/src/services/queueOrdering.ts
export const TIER_RANK_SQL = `
  CASE %TIER_COL%
    WHEN 'club' THEN 1
    WHEN 'plus' THEN 2
    ELSE 3
  END ASC`;

export const slotQueueOrderSql = () => `
  ${TIER_RANK_SQL.replace('%TIER_COL%', 'membership_tier_at_join')},
  position ASC,
  joined_at ASC`;
```

Used identically by `offerNext()` and by `GET /slots/:id/waitlist/me`. **The displayed number is the number you will actually get.** And the response carries the breakdown so the UI can be honest *and* sell:

```json
{ "position": 3, "queue_length": 7,
  "ahead_of_you": { "club": 2, "plus": 0, "free": 0 },
  "your_tier": "free",
  "position_if_plus": 1,
  "estimated_chance": "medium" }
```

That renders as *"2 Club-Mitglieder haben Vorrang — mit Plus wärst du #1"* with an inline upgrade CTA to `/membership`. Tier priority is already disclosed pre-join at `apps/mobile/app/event/register/[id].tsx:267` and sold at `membership.tsx:290`; this keeps courts consistent with tournaments and with what the €7.99/€14.99 tiers promise.

*Post-MVP knob* (do not ship at MVP): aging, `effective_position = position − tier_boost + floor(minutes_waiting / 15)`, so a free-tier user cannot be starved indefinitely on a popular slot.

### 3.2 `SlotQueueService.onSlotFreed` — the atomic offer

Called **inside** the caller's transaction from all four release paths:

| Path | File:line | Change |
|---|---|---|
| user cancel | `courtBookingService.ts:262-274` | slot already locked at `:234-237` → just call |
| Stripe failure | `courtBookingService.ts:170-178` | add `.forUpdate()` select before the update |
| 15-min expiry | `courtBookingService.ts:201-209` | add `.forUpdate()` select before the update |
| admin un-book | `courtAvailabilityService.ts:68-78` | wrap in a transaction + lock (4th path, currently silent) |

```ts
static async onSlotFreed(trx: Knex.Transaction, slotId: number, reason: FreeReason, outbox: Event[]) {
  const now = new Date();
  const slot = await trx(t('court_availability')).where('id', slotId).forUpdate().first();
  if (!slot || (slot.status !== 'booked' && slot.status !== 'held')) return;

  const minutesToStart = (new Date(slot.starts_at_utc).getTime() - now.getTime()) / 60000;

  // Too close to tip-off: a hold would waste the slot. Release to open race.
  if (minutesToStart < MIN_MINUTES_FOR_HOLD /* 30 */) {
    await this.release(trx, slot, outbox);
    return;
  }

  const next = await trx(t('slot_waitlist'))
    .where({ slot_id: slotId, status: 'queued' })
    .whereNotIn('user_id', await this.suppressedUserIds(trx, slotId, now))  // quiet hours + cooldown
    .orderByRaw(slotQueueOrderSql())
    .first();

  if (!next) { await this.release(trx, slot, outbox); return; }

  // Hold never outlives the slot's usefulness, and shrinks under urgency.
  const windowMin = minutesToStart > 120 ? CLAIM_WINDOW_LONG /*10*/ : CLAIM_WINDOW_SHORT /*5*/;
  const ttlMin    = Math.min(windowMin, Math.max(1, minutesToStart - 15));
  const expiresAt = new Date(now.getTime() + ttlMin * 60_000);

  const [offerId] = await trx(t('slot_offers')).insert({
    slot_id: slotId, waitlist_id: next.id, user_id: next.user_id,
    status: 'pending', offered_at: now, expires_at: expiresAt,
    cascade_depth: await this.cascadeDepth(trx, slotId),
    created_at: now, updated_at: now,
  });

  await trx(t('slot_waitlist')).where('id', next.id)
    .update({ status: 'offered', updated_at: now });

  await trx(t('court_availability')).where('id', slotId)
    .whereIn('status', ['booked', 'held'])                    // guard
    .update({
      status: 'held',
      held_for_user_id: next.user_id,
      hold_offer_id: offerId,
      hold_expires_at: expiresAt,
      version: trx.raw('version + 1'),
      updated_at: now,
    });

  // Notification row inside the trx (the registrationService.ts:286-293 pattern);
  // FCM push + ws frames flushed by the caller after commit.
  await trx(t('notifications')).insert({
    user_id: next.user_id, type: 'slot_offer',
    title: 'Du bist dran! 🎾',
    body: `Platz frei am ${fmtDe(slot)} — du hast ${ttlMin} Minuten.`,
    data: JSON.stringify({ slot_id: slotId, offer_id: offerId, expires_at: expiresAt }),
    dedupe_key: `slot_offer:${offerId}`,
    created_at: now,
  });

  outbox.push(
    { topic: `slot:${slotId}`,        event: 'slot_held',     payload: { slot_id: slotId } },
    { topic: `venue:${slot.venue_id}`,event: 'slot_held',     payload: { slot_id: slotId } },
    { topic: `user:${next.user_id}`,  event: 'offer_created', payload: { slot_id: slotId, offer_id: offerId, expires_at: expiresAt } },
  );
}
```

`release()` sets `status:'available'`, nulls the hold columns, bumps `version`, and pushes `slot_freed` to `slot:`, `venue:` and `city:<slug>` — that frame is the live feed.

### 3.3 Claim — MariaDB transaction, exact shape

```ts
// POST /slots/:id/claim
static async claim(slotId: number, userId: number, offerId: number) {
  const { bookingId, canPayInApp, ... } = await db.transaction(async (trx) => {
    const slot = await trx(t('court_availability')).where('id', slotId).forUpdate().first();
    if (!slot) throw AppError.notFound('Slot');
    // 409 not 403 everywhere — never reveal who holds the slot.
    if (slot.status !== 'held')                 throw AppError.conflict('Dieses Angebot ist abgelaufen');
    if (slot.held_for_user_id !== userId)       throw AppError.conflict('Dieses Angebot ist abgelaufen');
    if (slot.hold_offer_id !== offerId)         throw AppError.conflict('Dieses Angebot ist abgelaufen');
    if (new Date(slot.hold_expires_at) <= new Date()) throw AppError.conflict('Dieses Angebot ist abgelaufen');

    // REUSE: the identical booking-row/notification logic extracted out of
    // bookSlot (courtBookingService.ts:52-82). Not a fork.
    const created = await CourtBookingService.createBookingInTrx(trx, slot, userId, 'Warteschlange');

    await trx(t('slot_offers')).where('id', offerId)
      .update({ status: 'claimed', responded_at: now, booking_id: created.bookingId, updated_at: now });
    await trx(t('slot_waitlist')).where({ slot_id: slotId, user_id: userId })
      .update({ status: 'claimed', resolved_at: now, updated_at: now });
    // Everyone else on this slot is done.
    await trx(t('slot_waitlist')).where('slot_id', slotId).where('status', 'queued')
      .update({ status: 'superseded', resolved_at: now, updated_at: now });
    // createBookingInTrx already set status='booked'; clear the hold columns.
    await trx(t('court_availability')).where('id', slotId)
      .update({ held_for_user_id: null, hold_offer_id: null, hold_expires_at: null,
                version: trx.raw('version + 1'), updated_at: now });
    return created;
  });

  // Stripe outside the transaction — the same discipline as bookSlot:93-123,
  // extracted as attachPaymentIntent() and shared by both paths.
  return CourtBookingService.attachPaymentIntent(bookingId, ...);
}
```

**Why two people can't claim the same slot:** every claim, offer, expiry, join and direct `bookSlot` starts by taking an X-lock on the same single `court_availability` row. InnoDB serialises them. The second transaction to arrive sees `status` already flipped and returns a clean 409 — the exact behaviour `bookSlot` already has, and the exact 409 the mobile screen already handles at `venue/availability/[id].tsx:171-181`. There is no second lock to order against, so no deadlock is constructible.

### 3.4 Auto-advance

New scheduled job in `apps/backend/src/jobs/index.ts` alongside the existing eight:

```ts
{
  name: 'slot-offer-expiry',
  everyMs: 30 * 1000,          // 60s granularity on a 5-min window is 20% error
  run: () => SlotQueueService.expireOffers(),
}
```

`expireOffers()` selects `court_availability WHERE status='held' AND hold_expires_at < NOW()` (covered by `_hold_idx`), then per slot in its own transaction: lock the slot, mark the offer `expired`, mark the waitlist entry `expired`, increment the user's rolling no-response counter, then call `onSlotFreed(trx, slotId, 'offer_expired', outbox)` — which cascades to the next person atomically. Emits `offer_expired` on `user:<id>`.

**Cascade cap.** If `cascade_depth >= MAX_CASCADE (10)` — ten people offered and ignored — stop offering and `release()` to `available` with a public `slot_freed` broadcast. A dead queue must never hold a court hostage for an hour.

Also add `slot-watch-expiry` (daily) to deactivate watches past `date_to`, and `slot-watch-digest` (2 min) — see §4.

### 3.5 Anti-abuse

- `UNIQUE(slot_id, user_id)` — no double-queueing.
- **Concurrent queue cap** enforced in the join transaction: 5 free / 10 Plus / 20 Club active entries. Returns `429 QUEUE_LIMIT_REACHED` with the tier upsell.
- **No queueing a slot you already own**, and no queueing a slot that overlaps a confirmed booking you already hold (`WHERE starts_at_utc < :end AND ends_at_utc > :start` on `court_bookings` joined to availability — cheap now that the UTC columns exist). Stops the "queue everything, decide later" pattern that makes positions meaningless.
- **No-response cooldown**: 3 expired offers in a rolling 30 days → 24 h skip from `suppressedUserIds()`. The user keeps their queue entries and sees *"Du wirst gerade übersprungen — 3 Angebote nicht eingelöst"*. Not a ban, a friction.
- **Declines are free.** "Weitergeben" costs nothing and advances the queue instantly. Make the good behaviour the cheap one.
- New `queueLimiter` in `middleware/rateLimiter.ts` (30/min) on join/leave/claim/decline, following the `paymentLimiter` shape.
- Watches: max 10 active per user (25 Club), and geo watches require `radius_km <= 50`.

---

## 4. Push

Two channels, because iOS gives you no third option.

### 4.1 Visible push

**`slot_offer`** — time-critical, the user explicitly joined this queue, it expires.
```
Titel: „Du bist dran! 🎾"
Body:  „Padel Zentrum München · Do 19:00–20:30 · 28 € — 10 Minuten Zeit"
data:  { type:'slot_offer', slot_id, offer_id, expires_at, deep_link:'tourneo://slot/98765/claim' }
```
APNs: `interruption-level: 'time-sensitive'` (iOS 15+, pierces Focus modes — legitimately correct for an expiring offer the user opted into), `apns-priority: 10`, and a registered **notification category `SLOT_OFFER` with two actions: „Sichern" and „Weitergeben"** so the claim happens from the lock screen. That action is the flagship moment of the whole feature.

**`slot_watch_hit`** — a standing watch matched. Coalesced, never one-per-slot.

### 4.2 Silent push

Data-only, `content-available: 1`, `apns-push-type: background`, `apns-priority: 5`, FCM `android.priority: 'high'`, no `notification` block. New method on the existing service:

```ts
// apps/backend/src/services/notificationService.ts
static async sendData(userId: number, data: Record<string, string>): Promise<void>
```

Purpose: warm the client so a backgrounded app has fresh state when opened. **Be honest about it in code comments and in planning: iOS budgets silent pushes aggressively and guarantees nothing.** It is an optimisation, never a mechanism. Requires `"UIBackgroundModes": ["remote-notification"]` under `ios.infoPlist` in `apps/mobile/app.json:19-32` — currently absent, so this is a native rebuild, which is why it belongs in Phase 3, not MVP.

### 4.3 Quiet hours

Default 22:00–07:00 in the user's `notification_prefs.timezone`.

- **`slot_offer` does not get muted — it gets skipped.** If a user is inside quiet hours *and* `pause_offers_during_quiet_hours = true`, `suppressedUserIds()` excludes them from `offerNext`. They **keep their position** for the next opening and it does **not** count as a no-response. This is the honest semantics: never wake someone at 02:00, and never silently burn their turn either. One `WHERE` clause, evaluated in Node against the prefs row (not `CONVERT_TZ`, for the reason in §1.1).
- **`slot_watch_hit` fully respects quiet hours** and is held for the digest job.

### 4.4 Dedupe

`notifications.dedupe_key` (unique) is the idempotency key:

| Notification | Key |
|---|---|
| offer | `slot_offer:<offer_id>` |
| offer expired | `slot_offer_expired:<offer_id>` |
| watch hit | `watch_hit:<user_id>:<venue_id>:<unix_minute/10>` |

Insert conflict → already sent → skip the FCM call entirely. This makes the path safe under BullMQ's `attempts: 3` retry (`jobs/index.ts:125`) and under multi-instance workers. Do this before Redis fan-out exists, not after.

### 4.5 Digest / volume control

`slot-watch-digest` job every 2 min: groups pending watch hits by `(user_id, venue_id)` into a single push — *"4 Plätze frei geworden — Padel Zentrum, heute 18–21 Uhr"* — enforces `max_slot_alerts_per_day` (5 free / 15 Plus) and a 10-minute per-user debounce via `slot_watches.last_notified_at`. One busy Saturday evening at one club must never produce 40 pushes; that is how a flagship feature becomes an uninstall.

---

## 5. Where availability data actually comes from

### The honest options

| Option | Reality | Verdict |
|---|---|---|
| **Venue self-serve portal** | Needs `club_admin` role + `venue_managers` table + web UI. The role enum at `001_initial_schema.ts:17` is `('user','admin','superadmin')` — no venue role exists. Requires signing and training every club. 4–8 weeks of BD before data flows. | Necessary long-term. Not available at launch. |
| **Partner API / Playtomic** | `playtomicService.ts` is a skill-level→ELO mapper (0–7 interpolation, screenshot verification); it makes **zero HTTP calls**. Playtomic has no public third-party availability API. Scraping their tenant endpoints is a ToS breach and, in Germany, exposed under UrhG §87b database rights and UWG §4. | **Do not build.** Legal risk with no upside. |
| **iCal / CSV import** | Many German clubs run eversports, Courtbooking, Gymo, or a shared Google Calendar and can export or share an `.ics` URL. No contract needed — just "schick uns den Export-Link". | **Cheapest real supply.** Effort M. |
| **Crowd-sourced "Platz ist frei"** | Unverifiable. Burns trust fast if shown as truth. | v2, heavily gated. |
| **Derived from `venues.operating_hours`** | The JSON column already exists (`001_initial_schema.ts:164`). Produces a *speculative* grid. | Coverage filler, must be labelled. |

### Recommendation: invert the product for launch

**Do not launch a booking inventory you don't have. Launch the queue itself, on demand-side data you already own.**

1. **The one live signal Tourneo genuinely owns on day one is its own bookings.** Every cancellation (`courtBookingService.ts:216-278`), payment failure (`:161-180`) and 15-minute expiry (`:186-214`) frees a slot *inside Tourneo* — 100% accurate, zero partners required. Small at first, but every one of those is a real "das wird gerade frei" event that today vanishes silently.

2. **Seed supply with the generator you already have.** `generateRecurring` (`courtAvailabilityService.ts:105-197`) writes up to 5000 slots per call and applies `pricing_rules` automatically. Ten to twenty launch venues × one JSON POST each = a quarter of coverage in one day of ops work. Not an ongoing burden — the audit's "every slot hand-typed" framing overstates this.

3. **Ship the `source` column (§1.1) and let the UI tell the truth.** `venue`/`import` slots render "Buchen". `assumed`/`crowd` slots render **„Voraussichtlich frei — beim Club anfragen"** with a call button and the `external_booking_links` deep-link that `venue/[id].tsx:157-166` already implements. This is the honesty valve that lets you ship coverage without lying, and it is what keeps you out of §5 UWG territory.

4. **`slot_watches` is the sales engine.** Record `venue_id` on watches **even for venues with zero inventory**. Six weeks in you walk into a club with: *"37 Spieler haben diese Woche auf einen Platz bei euch gewartet. Hier ist euer Portal-Login."* That is the pitch that converts clubs, and it is why the watch table is more strategically valuable than the queue table.

5. **Crowd reports (Phase 3, gated):** only from users with a prior confirmed booking at that venue, 90-minute confidence decay, and **never** promoted to a bookable slot — only to a "gerade frei gemeldet" live card with a phone-the-club CTA.

The one-line pitch this design supports at launch: **"Tourneo zeigt dir live, was frei wird — und stellt dich automatisch an."** That is true on day one with only Tourneo's own booking flow behind it.

---

## 6. Mobile UX

### Screens

| Path | Status | What |
|---|---|---|
| `apps/mobile/app/(tabs)/spielen.tsx:272-274` | **fix** | `'plaetze'` currently `router.push('/(tabs)/turniere')` — a 3-line mis-wire. Point it at `/courts`. |
| `apps/mobile/app/courts/index.tsx` | **new** | "Plätze finden". Two segments: **Jetzt frei** (live feed) / **Suchen** (filters). The flagship screen. |
| `apps/mobile/app/venue/availability/[id].tsx` | **extend** | ws `venue:<id>`; new `held` and `queued` slot states; "Benachrichtige mich (4 warten)" on booked slots; `useFocusEffect` + 30s AppState-gated poll fallback. |
| `apps/mobile/app/slot/[id]/claim.tsx` | **new** | The claim screen. Push deep-link target. |
| `apps/mobile/app/courts/watches.tsx` | **new** | "Meine Platz-Alerts" — list, mute, delete, quiet-hours link. |
| `apps/mobile/app/bookings.tsx` | **extend** | New "In der Warteschlange" section above upcoming; fix the mount-only fetch at `:53-61`. |
| `apps/mobile/app/(tabs)/home.tsx` | **extend** | Live card: "3 Plätze gerade frei geworden in deiner Nähe". |

**Tab structure: stays at five.** Court finding lives under `spielen` (fix the CTA) plus the home live card. No sixth tab.

### Components

- **`SlotQueueSheet`** — bottom sheet from a booked slot. Queue length, your would-be position, tier breakdown (*"2 Club-Mitglieder vor dir — mit Plus wärst du #1"* + upgrade CTA), join/leave, a toggle "Automatisch sichern" (Club perk, sets `auto_claim`).
- **`QueuePositionBadge`** — reused in three places, live-updating from `user:<id>` `position_changed` frames. Renders `#3 von 7` with a subtle pulse on change.
- **`ClaimCountdown`** — the emotional peak. A large ring counting `10:00 → 0:00`, driven by `requestAnimationFrame` off `Animated`, **resynced to the server's `hold_expires_at` on every screen focus** so backgrounding the app cannot cheat it. Under 60s it turns red and haptics tick once per second. Two buttons: giant **„Platz sichern"**, and quiet **„Weitergeben"** (immediate `POST /slots/:id/decline`, advances the queue, feels generous, and is cheaper for you than an expiry).
- **`LiveSlotCard`** — enters the live feed with `LayoutAnimation.easeInEaseOut` + `Haptics.impactAsync(Light)`, carries a "vor 12 Sek. frei geworden" relative timestamp and a `source` badge for assumed/crowd slots.
- **`LivePill`** — 🔴 Live / ⚪️ Verbindung… driven by the realtime provider's connection state, so the user always knows whether they're seeing truth or a snapshot.

### Deep link + notification handling

Register `tourneo://slot/:id/claim`. In the `expo-notifications` response listener route to `/slot/[id]/claim`; also call `getLastNotificationResponseAsync()` on cold start (the case everyone forgets — the offer push is *specifically* the one that arrives while the app is dead). Handle the APNs category actions: "Sichern" → background `POST /claim` then a local success notification; "Weitergeben" → background `POST /decline`.

---

## 7. API surface

All under `/api/v1`. New router `apps/backend/src/routes/slots.ts`, mounted in `routes/index.ts` as `router.use('/slots', slotRouter)`.

### Discovery
```
GET  /slots/search        optionalAuth
     ?lat&lng&radius_km&date_from&date_to&time_from&time_to
     &duration_min&max_price_cents&sport&indoor&venue_id&limit&cursor
  → { success, data:[{ id, venue_id, venue_name, court_id, court_name, distance_km,
                       slot_date, slot_start, slot_end, starts_at_utc, price_cents,
                       status, source, confidence, queue_length, booking_url }],
      meta:{ next_cursor } }
  Implementation: join court_availability → venues (reuse the Haversine raw from
  venueController.ts:38-58) → courts; filter on starts_at_utc; index
  (starts_at_utc, status) + the existing (venue_id, slot_date, status).

GET  /slots/live?city=|lat&lng&radius_km&limit    optionalAuth
  → slots that transitioned to available/held in the last 60 min. The "was wird frei" feed.

GET  /slots/:id            optionalAuth
  → slot + venue + { queue_length, my_entry:{ position, status } | null,
                     hold:{ expires_at } | null }   // held_for_user_id NEVER exposed
```

### Queue
```
POST   /slots/:id/waitlist        authenticate, queueLimiter
       body { auto_claim?: boolean }
  → 201 { entry_id, position, queue_length, ahead_of_you:{club,plus,free},
          your_tier, position_if_plus, estimated_chance }
  → 409 SLOT_ALREADY_AVAILABLE  (just book it)
  → 409 ALREADY_QUEUED
  → 429 QUEUE_LIMIT_REACHED { limit, your_tier, upgrade_limit }

DELETE /slots/:id/waitlist        authenticate → 204
GET    /slots/:id/waitlist/me     authenticate → same shape as POST 201
GET    /me/waitlist               authenticate
  → { queued:[…], offers:[{ offer_id, slot:{…}, expires_at, seconds_left }] }

POST   /slots/:id/claim           authenticate, queueLimiter
       body { offer_id }
  → 201 { …booking, client_secret }        (identical shape to POST /bookings)
  → 409 SLOT_OFFER_EXPIRED                 (also for "not yours" — never leak the holder)

POST   /slots/:id/decline         authenticate
       body { offer_id }  → 204, advances the queue immediately
```

### Watches
```
POST   /slot-watches      authenticate
       { venue_id? | lat,lng,radius_km, date_from, date_to, time_from, time_to,
         weekday_mask?, sport?, indoor_only?, max_price_cents?,
         min_duration_minutes?, auto_queue? }  → 201 { id, estimated_matches_per_week }
GET    /slot-watches      authenticate → [{ …, hit_count, last_notified_at }]
PATCH  /slot-watches/:id  authenticate { is_active?, … } → 200
DELETE /slot-watches/:id  authenticate → 204
```

### Preferences
```
GET /me/notification-prefs   authenticate
PUT /me/notification-prefs   authenticate
    { timezone, quiet_hours_start, quiet_hours_end, slot_alerts_enabled,
      pause_offers_during_quiet_hours, max_slot_alerts_per_day }
```

### Venue-side supply (Phase 3, `club_admin` or `adminOnly`)
```
POST   /venues/:id/availability             single slot   (wraps upsertSlot)
POST   /venues/:id/availability/recurring   bulk          (wraps generateRecurring)
POST   /venues/:id/availability/import      { format:'csv'|'ical', url? } | multipart
PATCH  /venues/:id/availability/:slotId     { status }
       // blocking a booked slot MUST cancel the booking, notify its owner,
       // and run onSlotFreed — this is the club-cancels-your-court path
       // that today has no UI and no notification at all.
GET    /venues/:id/demand                   queue/watch analytics — the sales asset
```
Existing `GET /venues/:id/availability` (`routes/venues.ts:43-60`) is preserved byte-compatible, gaining an optional `?include_queue=true`.

### WebSocket
```
GET /ws?token=<access_jwt>     (existing upgrade path, index.ts:139)
```

---

## 8. Staged build plan

### Phase 0 — Foundations · ~4–5 days · **blocks everything**
A queue built on duplicated slot rows or a 2-hour-wrong clock is worse than no queue.

| Item | Effort |
|---|---|
| Migration 018 + Node backfill script + boot assertion for `CONVERT_TZ` | M |
| Delete `combineDateTime`; `bookSlot`/`cancelBooking`/`bookingReminder.ts` read `starts_at_utc` | S |
| `generateRecurring` → `ON DUPLICATE KEY UPDATE`; `upsertSlot` likewise; write `starts_at_utc`/`sport` | S |
| Extract `createBookingInTrx` + `attachPaymentIntent` from `bookSlot` (`courtBookingService.ts:52-123`) | S |
| Extract `queueOrdering.ts`; fix `bracketService.ts:834` and `admin.ts:575-579` to use it | S |
| Fix the IDOR on `GET /registrations/:id/waitlist-status` (`routes/registrations.ts:11`) | S |

### Phase 1 — MVP go-live · ~3 weeks · **the owner's feature, shipped**

| Item | Effort |
|---|---|
| Migration 019 (`slot_waitlist`, `slot_offers`, `notification_prefs`, enum + `dedupe_key`) | M |
| `SlotQueueService`: join / leave / position / `onSlotFreed` / claim / decline / `expireOffers` | L |
| Hook all four release paths (3× `courtBookingService`, 1× `courtAvailabilityService.upsertSlot`) | S |
| `slot-offer-expiry` job @30s in `jobs/index.ts` | S |
| `realtime/hub.ts`: topics, JWT auth, seq + ring-buffer backfill, heartbeat; `liveBracket.ts` shim | L |
| `routes/slots.ts`: queue + `GET /slots/:id` + `/me/waitlist`; `queueLimiter` | M |
| `NotificationService`: `slot_offer` push, `dedupe_key`, quiet-hours skip, APNs `SLOT_OFFER` category | M |
| Mobile: `RealtimeProvider` + `useTopic`, AppState/half-open handling | M |
| Mobile: availability screen live + `held` state + `SlotQueueSheet` + `useFocusEffect` fallback | M |
| Mobile: `slot/[id]/claim.tsx` + `ClaimCountdown` + deep link + cold-start handling | M |
| Mobile: `bookings.tsx` queue section | S |
| Admin dashboard: availability tab (wired to the two existing endpoints) | M |
| Tests: concurrent-claim race, cascade-on-expiry, cascade cap, dedupe under retry | M |

**Ships as:** *"Platz belegt? Stell dich an. Wir halten ihn 10 Minuten für dich, sobald er frei wird."* — with Tourneo's own cancellations as the supply.

### Phase 2 — Discovery · ~2 weeks

| Item | Effort |
|---|---|
| `GET /slots/search` + `GET /slots/live` (Haversine reuse + covering index) | M |
| `apps/mobile/app/courts/index.tsx` — search + live feed, `city:` topic | L |
| Home live card; fix `spielen.tsx:272-274` | S |
| iCal / CSV importer + `source` labelling in the UI (assumed/crowd → "anfragen") | M |

### Phase 3 — Supply & scale · ~2–3 weeks

| Item | Effort |
|---|---|
| `venue_managers` + `club_admin` role + venue portal (slot CRUD, recurring, import, block) | XL |
| `slot_watches` + matcher + `slot-watch-digest` job + `courts/watches.tsx` | L |
| Silent push + `UIBackgroundModes` in `app.json` (native rebuild) | M |
| Redis pub/sub adapter for the hub; seq via `INCR` | M |
| `GET /venues/:id/demand` — the club sales report | S |
| Crowd-sourced "Platz ist frei" (gated, decayed, never bookable) | L |

### Phase 4 — Polish · ~1–2 weeks
Auto-claim for Club (`auto_claim` already in the schema), queue aging/decay knob, no-show scoring surfaced to the user, "Weitergeben an einen Freund", queue analytics in the admin dashboard.

---

## Three things that will bite if skipped

1. **Free the slot to `held` inside the cancelling transaction, never to `available` first.** Anything else means the queue can be beaten by a pull-to-refresh, and the feature is a lie the first time it happens to a paying member.
2. **The `court_availability` unique key must land before the queue does.** Two duplicate rows for one physical court means two independent queues, two holds, two bookings, and one very angry club. `court_id` is nullable, so a plain `UNIQUE` will not do it — the `COALESCE(court_id,0)` generated column is required.
3. **One ordering SQL fragment, three call sites.** The repo already has this exact bug for tournaments (`bracketService.ts:834` FIFO vs `registrationService.ts:262-270` tier-first vs `admin.ts:575-579` FIFO — three orderings, one advertised paid benefit). Do not reproduce it on courts, where the number is on screen with a countdown next to it.