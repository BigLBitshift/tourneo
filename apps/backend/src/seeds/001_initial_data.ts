import { Knex } from 'knex';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

const PREFIX = process.env.DB_TABLE_PREFIX || 'tourneo_';
const t = (name: string) => `${PREFIX}${name}`;

export async function seed(knex: Knex): Promise<void> {
  const now = new Date();

  // Idempotency guard: the seed creates baseline data (legal documents,
  // admin user, demo venues/events). Running it twice would violate the
  // unique email constraint and duplicate venues, so we bail out if the
  // baseline already exists.
  const existingTerms = await knex(t('legal_document_versions'))
    .where({ document_type: 'terms', locale: 'de', is_active: true })
    .first();
  if (existingTerms) {
    console.log('ℹ️  Seed skipped — baseline data already present.');
    return;
  }

  // ==========================================
  // LEGAL DOCUMENTS
  // ==========================================
  await knex(t('legal_document_versions')).insert([
    {
      document_type: 'terms',
      version: '1.0.0',
      locale: 'de',
      title: 'Teilnahmebedingungen',
      content: '# Teilnahmebedingungen\n\n**⚠️ ENTWURF – VOR LIVEGANG DURCH DEUTSCHEN RECHTSANWALT PRÜFEN LASSEN**\n\n## 1. Geltungsbereich\nDiese Teilnahmebedingungen gelten für alle über die Tourneo-Plattform organisierten Veranstaltungen.\n\n## 2. Teilnahmevoraussetzungen\n- Mindestalter: 18 Jahre\n- Gültiger Account bei Tourneo\n- Erfolgreiche Zahlung der Teilnahmegebühr\n\n## 3. Anmeldung und Zahlung\n- Die Anmeldung ist erst nach vollständiger Bezahlung gültig.\n- Jeder Teilnehmer darf nur einen Account besitzen.\n\n## 4. Stornierung und Rückerstattung\n- Bis 14 Tage vor Turnierbeginn: 75% Rückerstattung\n- Weniger als 14 Tage vor Turnierbeginn: Keine Rückerstattung\n- Bei Absage durch den Veranstalter: 100% Rückerstattung\n\n## 5. Preisgeld\n- Das Preisgeld wird pro Turnier vorab definiert und garantiert.\n- Die Verteilung wird auf der Eventseite transparent dargestellt.\n\n## 6. Haftung\n⚠️ Haftungsklausel durch Rechtsanwalt formulieren lassen.\n\n## 7. Veranstalter\nTourneo / Lukas Gross\nEinzelunternehmen, Deutschland',
      is_active: true,
      published_at: now,
      created_at: now,
      updated_at: now,
    },
    {
      document_type: 'terms',
      version: '1.0.0',
      locale: 'en',
      title: 'Terms of Participation',
      content: '# Terms of Participation\n\n**⚠️ DRAFT – MUST BE REVIEWED BY A GERMAN ATTORNEY BEFORE LAUNCH**\n\n## 1. Scope\nThese terms apply to all events organized through the Tourneo platform.\n\n## 2. Eligibility\n- Minimum age: 18 years\n- Valid Tourneo account\n- Successful payment of entry fee\n\n## 3. Registration and Payment\n- Registration is only valid after full payment.\n- Each participant may only have one account.\n\n## 4. Cancellation and Refunds\n- Up to 14 days before event: 75% refund\n- Less than 14 days before event: No refund\n- If organizer cancels: 100% refund\n\n## 5. Prize Money\n- Prize money is defined and guaranteed per tournament.\n- Distribution is transparently shown on the event page.\n\n## 6. Liability\n⚠️ Liability clause to be drafted by attorney.\n\n## 7. Organizer\nTourneo / Lukas Gross\nSole proprietorship, Germany',
      is_active: true,
      published_at: now,
      created_at: now,
      updated_at: now,
    },
    {
      document_type: 'privacy',
      version: '1.0.0',
      locale: 'de',
      title: 'Datenschutzerklärung',
      content: '# Datenschutzerklärung\n\n**⚠️ ENTWURF – VOR LIVEGANG DURCH DEUTSCHEN RECHTSANWALT UND DATENSCHUTZBEAUFTRAGTEN PRÜFEN LASSEN**\n\n## 1. Verantwortlicher\nLukas Gross\n⚠️ Vollständige Adresse einfügen\nE-Mail: datenschutz@tourneo.de\n\n## 2. Erhobene Daten\n- Account-Daten (Name, E-Mail, Geburtsdatum)\n- Profildaten (Stadt, Profilbild)\n- Zahlungsdaten (verarbeitet durch Stripe)\n- Nutzungsdaten (App-Interaktionen)\n- Standortdaten (für Platz-Discovery, nur mit Einwilligung)\n\n## 3. Rechtsgrundlagen\n- Art. 6 Abs. 1 lit. a DSGVO (Einwilligung)\n- Art. 6 Abs. 1 lit. b DSGVO (Vertragserfüllung)\n- Art. 6 Abs. 1 lit. f DSGVO (Berechtigtes Interesse)\n\n## 4. Ihre Rechte\n- Auskunft (Art. 15 DSGVO)\n- Berichtigung (Art. 16 DSGVO)\n- Löschung (Art. 17 DSGVO)\n- Datenübertragbarkeit (Art. 20 DSGVO)\n- Widerspruch (Art. 21 DSGVO)\n\n## 5. Drittanbieter\n- Stripe (Zahlungsverarbeitung)\n- Apple (In-App-Käufe, Push-Benachrichtigungen)\n- Firebase (Cloud Messaging)\n\n⚠️ Auftragsverarbeitungsverträge müssen vor Livegang abgeschlossen werden.',
      is_active: true,
      published_at: now,
      created_at: now,
      updated_at: now,
    },
    {
      document_type: 'privacy',
      version: '1.0.0',
      locale: 'en',
      title: 'Privacy Policy',
      content: '# Privacy Policy\n\n**⚠️ DRAFT – MUST BE REVIEWED BEFORE LAUNCH**\n\nThis privacy policy explains how Tourneo collects, uses, and protects your personal data in accordance with the GDPR.\n\n⚠️ Full English privacy policy to be provided by legal counsel.',
      is_active: true,
      published_at: now,
      created_at: now,
      updated_at: now,
    },
    {
      document_type: 'imprint',
      version: '1.0.0',
      locale: 'de',
      title: 'Impressum',
      content: '# Impressum\n\nAngaben gemäß § 5 DDG:\n\nLukas Gross\n⚠️ Vollständige Adresse einfügen\n\nKontakt:\nE-Mail: kontakt@tourneo.de\n\n⚠️ Umsatzsteuer-ID einfügen (sofern vorhanden)\n⚠️ Weitere Pflichtangaben durch Rechtsanwalt prüfen lassen',
      is_active: true,
      published_at: now,
      created_at: now,
      updated_at: now,
    },
    {
      document_type: 'imprint',
      version: '1.0.0',
      locale: 'en',
      title: 'Legal Notice',
      content: '# Legal Notice (Impressum)\n\nInformation according to § 5 DDG:\n\nLukas Gross\n⚠️ Insert full address\n\nContact:\nEmail: kontakt@tourneo.de',
      is_active: true,
      published_at: now,
      created_at: now,
      updated_at: now,
    },
  ]);

  // ==========================================
  // SUPERADMIN USER
  // ==========================================
  // Never hardcode the admin password in the repo. Take it from the
  // environment; otherwise generate a random one and print it exactly
  // once so the operator can store it in a password manager.
  const adminEmail = process.env.SEED_ADMIN_EMAIL || 'gross.lukas01@web.de';
  let adminPassword = process.env.SEED_ADMIN_PASSWORD;
  if (!adminPassword) {
    adminPassword = crypto.randomBytes(12).toString('base64url');
    console.log('');
    console.log('🔑 Generated superadmin credentials (store these now, they are not saved anywhere):');
    console.log(`   Email:    ${adminEmail}`);
    console.log(`   Password: ${adminPassword}`);
    console.log('');
  }
  const passwordHash = await bcrypt.hash(adminPassword, 12);
  const adminUuid = uuidv4();

  const [adminId] = await knex(t('users')).insert({
    uuid: adminUuid,
    email: adminEmail,
    password_hash: passwordHash,
    email_verified: true,
    role: 'superadmin',
    status: 'active',
    created_at: now,
    updated_at: now,
  });

  await knex(t('profiles')).insert({
    user_id: adminId,
    first_name: 'Lukas',
    last_name: 'Gross',
    date_of_birth: '1995-01-01',
    city: 'Deutschland',
    country: 'DE',
    created_at: now,
    updated_at: now,
  });

  await knex(t('language_preferences')).insert({
    user_id: adminId,
    locale: 'de',
    system_detected_locale: 'de',
    manual_override: false,
    updated_at: now,
  });

  await knex(t('memberships')).insert({
    user_id: adminId,
    tier: 'club',
    status: 'active',
    started_at: now,
    created_at: now,
    updated_at: now,
  });

  // ==========================================
  // SAMPLE VENUES
  // ==========================================
  const [venue1Id] = await knex(t('venues')).insert({
    uuid: uuidv4(),
    name: 'Padel City München',
    description: 'Moderne Padel-Anlage im Herzen Münchens mit 6 Indoor-Courts und 2 Outdoor-Courts.',
    address_street: 'Sportplatzweg 10',
    address_city: 'München',
    address_zip: '80333',
    address_country: 'DE',
    latitude: 48.1351,
    longitude: 11.5820,
    is_indoor: true,
    is_outdoor: true,
    is_partner_venue: true,
    partner_website_url: 'https://example.com/padel-city',
    partner_booking_url: 'https://example.com/padel-city/booking',
    phone: '+49 89 12345678',
    email: 'info@padel-city-example.de',
    status: 'active',
    created_at: now,
    updated_at: now,
  });

  const [venue2Id] = await knex(t('venues')).insert({
    uuid: uuidv4(),
    name: 'Padel Arena Berlin',
    description: 'Berlins größte Padel-Anlage mit 8 Courts, Lounge und Bar.',
    address_street: 'Berliner Straße 42',
    address_city: 'Berlin',
    address_zip: '10115',
    address_country: 'DE',
    latitude: 52.5200,
    longitude: 13.4050,
    is_indoor: true,
    is_outdoor: false,
    is_partner_venue: true,
    partner_website_url: 'https://example.com/padel-arena-berlin',
    partner_booking_url: 'https://example.com/padel-arena-berlin/booking',
    status: 'active',
    created_at: now,
    updated_at: now,
  });

  // Courts
  for (let i = 1; i <= 6; i++) {
    await knex(t('courts')).insert({
      venue_id: venue1Id,
      name: `Court ${i}`,
      court_type: 'padel',
      is_indoor: i <= 4,
      surface: 'Kunstrasen',
      status: 'active',
      created_at: now,
      updated_at: now,
    });
  }

  for (let i = 1; i <= 8; i++) {
    await knex(t('courts')).insert({
      venue_id: venue2Id,
      name: `Court ${i}`,
      court_type: 'padel',
      is_indoor: true,
      surface: 'Kunstrasen',
      status: 'active',
      created_at: now,
      updated_at: now,
    });
  }

  // External booking links
  await knex(t('external_booking_links')).insert([
    { venue_id: venue1Id, label: 'Online buchen', url: 'https://example.com/padel-city/booking', link_type: 'booking', is_active: true, created_at: now, updated_at: now },
    { venue_id: venue1Id, label: 'Webseite', url: 'https://example.com/padel-city', link_type: 'website', is_active: true, created_at: now, updated_at: now },
    { venue_id: venue2Id, label: 'Online buchen', url: 'https://example.com/padel-arena-berlin/booking', link_type: 'booking', is_active: true, created_at: now, updated_at: now },
  ]);

  // ==========================================
  // SAMPLE EVENT
  // ==========================================
  const eventDate = new Date();
  eventDate.setDate(eventDate.getDate() + 30);
  const regOpens = new Date();
  regOpens.setDate(regOpens.getDate() + 1);
  const regCloses = new Date(eventDate);
  regCloses.setDate(regCloses.getDate() - 1);

  const [eventId] = await knex(t('events')).insert({
    uuid: uuidv4(),
    title: 'Tourneo Padel Open München',
    description: 'Das erste offizielle Tourneo Padel-Turnier in München! 32 Teams kämpfen um ein garantiertes Preisgeld von 950€. Kommt vorbei, spielt mit und erlebt einen unvergesslichen Tag.',
    sport_category: 'padel',
    event_type: 'tournament',
    venue_id: venue1Id,
    start_date: eventDate,
    end_date: new Date(eventDate.getTime() + 10 * 60 * 60 * 1000),
    registration_opens_at: regOpens,
    registration_closes_at: regCloses,
    club_early_access_at: new Date(regOpens.getTime() - 48 * 60 * 60 * 1000),
    plus_early_access_at: new Date(regOpens.getTime() - 24 * 60 * 60 * 1000),
    is_indoor: true,
    is_outdoor: false,
    format: 'doubles',
    elimination_type: 'single_elimination',
    has_third_place_match: true,
    max_participants: 32,
    entry_fee_cents: 3000,
    currency: 'EUR',
    total_prize_pool_cents: 95000,
    level: 'open',
    access_type: 'public',
    has_food_drinks: true,
    has_streaming: false,
    special_notes: 'Getränke und Snacks vor Ort verfügbar. Bitte eigene Padel-Schläger mitbringen.',
    rules_summary: 'Offizielles Padel-Regelwerk. Best of 3 Sätze. Tiebreak im dritten Satz.',
    status: 'published',
    created_by: adminId,
    published_at: now,
    created_at: now,
    updated_at: now,
  });

  // Prize distribution
  await knex(t('prize_distributions')).insert([
    { event_id: eventId, place: 1, amount_cents: 50000, currency: 'EUR', label: '1. Platz' },
    { event_id: eventId, place: 2, amount_cents: 20000, currency: 'EUR', label: '2. Platz' },
    { event_id: eventId, place: 3, amount_cents: 15000, currency: 'EUR', label: '3. Platz' },
    { event_id: eventId, place: 4, amount_cents: 5000, currency: 'EUR', label: '4. Platz' },
    { event_id: eventId, place: 5, amount_cents: 5000, currency: 'EUR', label: '5. Platz' },
  ]);

  console.log('✅ Seed data inserted successfully');
}