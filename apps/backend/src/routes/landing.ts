import { Router, Request, Response, NextFunction } from 'express';
import { db, t } from '../config/database';

const router = Router();

/**
 * Web landing pages for shared deep links (tourneo.de/match/123 etc.).
 *
 * Until now every shared link 404ed for people without the app — the
 * entire viral loop leaked. These pages render a server-side preview
 * with Open Graph tags (rich embeds in WhatsApp/Instagram/iMessage),
 * attempt to open the app via its custom scheme and fall back to a
 * store badge.
 *
 * Mounted at the server root (not /api) so the share URLs work as-is
 * when tourneo.de points at this server.
 */

function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string
  );
}

function page(opts: {
  title: string;
  description: string;
  appPath: string;
  body: string;
}): string {
  const deepLink = `tourneo://${opts.appPath}`;
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)} · Tourneo</title>
<meta property="og:title" content="${esc(opts.title)}">
<meta property="og:description" content="${esc(opts.description)}">
<meta property="og:site_name" content="Tourneo">
<meta property="og:type" content="website">
<meta name="apple-itunes-app" content="app-argument=${esc(deepLink)}">
<style>
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    background:linear-gradient(160deg,#0E1B4D,#0A0A14 60%,#070710);color:#fff;
    min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{max-width:420px;width:100%;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);
    border-radius:24px;padding:32px;text-align:center}
  .brand{color:#8B9DFF;font-size:13px;font-weight:800;letter-spacing:4px;margin-bottom:20px}
  h1{font-size:24px;margin:0 0 8px;line-height:1.3}
  p{color:rgba(255,255,255,.65);font-size:15px;line-height:1.5}
  .score{font-size:34px;font-weight:800;margin:18px 0;letter-spacing:2px}
  .cta{display:inline-block;margin-top:24px;background:#4B5FFF;color:#fff;text-decoration:none;
    font-weight:700;padding:15px 32px;border-radius:14px;font-size:16px}
  .hint{font-size:12px;color:rgba(255,255,255,.4);margin-top:14px}
</style>
</head>
<body>
<div class="card">
  <div class="brand">TOURNEO</div>
  ${opts.body}
  <a class="cta" href="${esc(deepLink)}">In der App öffnen</a>
  <p class="hint">Noch keine App? Tourneo gibt's im App Store.</p>
</div>
<script>
  // Best-effort app handoff; harmless no-op when the app isn't installed.
  setTimeout(function(){ window.location.href = ${JSON.stringify(deepLink)}; }, 400);
</script>
</body>
</html>`;
}

router.get('/match/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const matchId = parseInt(req.params.id, 10);
    if (!Number.isInteger(matchId)) return res.status(404).send('Not found');

    const { BracketService } = await import('../services/bracketService');
    let card: any = null;
    try {
      card = await BracketService.getMatchCard(matchId);
    } catch {
      // fall through to generic page
    }

    if (!card) {
      return res.send(
        page({
          title: 'Match auf Tourneo',
          description: 'Verfolge Padel-Matches live auf Tourneo.',
          appPath: `match/${matchId}`,
          body: `<h1>Match auf Tourneo</h1><p>Öffne die App für Live-Ergebnisse.</p>`,
        })
      );
    }

    const p1IsWinner = card.winner_registration_id === card.participant_1?.registration_id;
    const winner = (p1IsWinner ? card.participant_1 : card.participant_2)?.players
      .map((p: any) => p.name).join(' & ');
    const loser = (p1IsWinner ? card.participant_2 : card.participant_1)?.players
      .map((p: any) => p.name).join(' & ');
    const score = card.sets
      .map((s: any) => (p1IsWinner ? `${s.p1}:${s.p2}` : `${s.p2}:${s.p1}`))
      .join(' · ');

    res.send(
      page({
        title: `${winner} schlägt ${loser}`,
        description: `${score}${card.event?.title ? ` · ${card.event.title}` : ''} — auf Tourneo`,
        appPath: `match/${matchId}`,
        body: `
          <h1>🏆 ${esc(winner)}</h1>
          <p>schlägt ${esc(loser)}</p>
          <div class="score">${esc(score)}</div>
          ${card.event?.title ? `<p>${esc(card.event.title)}</p>` : ''}
          ${card.venue?.name ? `<p>📍 ${esc(card.venue.name)}</p>` : ''}`,
      })
    );
  } catch (error) {
    next(error);
  }
});

router.get('/event/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const eventId = parseInt(req.params.id, 10);
    if (!Number.isInteger(eventId)) return res.status(404).send('Not found');

    const event = await db(t('events')).where('id', eventId).first();
    if (!event || event.status === 'draft') return res.status(404).send('Not found');

    const date = event.start_date
      ? new Date(event.start_date).toLocaleDateString('de-DE', {
          weekday: 'long', day: 'numeric', month: 'long',
        })
      : '';

    res.send(
      page({
        title: event.title,
        description: `${date} — jetzt auf Tourneo anmelden`,
        appPath: `event/${eventId}`,
        body: `
          <h1>🎾 ${esc(event.title)}</h1>
          <p>${esc(date)}</p>
          ${event.total_prize_pool_cents > 0
            ? `<div class="score">${Math.round(event.total_prize_pool_cents / 100)} € Preisgeld</div>`
            : ''}
          <p>Melde dich jetzt in der Tourneo-App an.</p>`,
      })
    );
  } catch (error) {
    next(error);
  }
});

router.get('/profile/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = parseInt(req.params.id, 10);
    if (!Number.isInteger(userId)) return res.status(404).send('Not found');

    const profile = await db(t('profiles')).where('user_id', userId).first();
    if (!profile || !profile.discoverable) {
      return res.send(
        page({
          title: 'Spieler auf Tourneo',
          description: 'Padel-Profile, ELO-Ranking und Turniere auf Tourneo.',
          appPath: `profile/${userId}`,
          body: `<h1>Spieler auf Tourneo</h1><p>Öffne die App für das volle Profil.</p>`,
        })
      );
    }

    const name =
      profile.display_name ||
      [profile.first_name, profile.last_name].filter(Boolean).join(' ') ||
      'Spieler';

    res.send(
      page({
        title: name,
        description: `ELO ${profile.elo_padel ?? 1000} · Fordere ${name} auf Tourneo heraus`,
        appPath: `profile/${userId}`,
        body: `
          <h1>${esc(name)}</h1>
          ${profile.city ? `<p>📍 ${esc(profile.city)}</p>` : ''}
          <div class="score">ELO ${esc(profile.elo_padel ?? 1000)}</div>
          <p>Fordere ${esc(name)} in der Tourneo-App heraus.</p>`,
      })
    );
  } catch (error) {
    next(error);
  }
});

export { router as landingRouter };
