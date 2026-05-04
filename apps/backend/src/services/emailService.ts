import nodemailer, { Transporter } from 'nodemailer';
import { env } from '../config/environment';

// Minimal HTML escaper for user-controlled values that get interpolated
// into HTML email bodies. Without this, a display name like
// `<script>...</script>` or even `<style>` would be rendered by some
// email clients (and by webmail previews) — it is also a defence against
// injecting markup that breaks our layout.
function escapeHtml(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"'`]/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      case '`': return '&#96;';
      default: return ch;
    }
  });
}

/**
 * Email service – wraps nodemailer with simple, branded templates.
 *
 * Configuration is taken from process.env via the central env loader:
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD,
 *   SMTP_FROM_NAME, SMTP_FROM_EMAIL, APP_URL
 *
 * In development (no SMTP_USER / SMTP_PASSWORD) emails are logged instead
 * of being sent so that local registration flows still work.
 */
class EmailService {
  private transporter: Transporter | null = null;
  private initAttempted = false;

  private getTransporter(): Transporter | null {
    if (this.initAttempted) return this.transporter;
    this.initAttempted = true;

    if (!env.smtp.host || !env.smtp.user || !env.smtp.password) {
      console.warn('[email] SMTP credentials missing – emails will be logged only.');
      return null;
    }

    this.transporter = nodemailer.createTransport({
      host: env.smtp.host,
      port: env.smtp.port,
      secure: env.smtp.port === 465,
      auth: {
        user: env.smtp.user,
        pass: env.smtp.password,
      },
    });

    return this.transporter;
  }

  private fromHeader(): string {
    return `"${env.smtp.fromName}" <${env.smtp.fromEmail}>`;
  }

  private async send(to: string, subject: string, html: string, text: string): Promise<void> {
    const transporter = this.getTransporter();
    if (!transporter) {
      console.log(`[email:dev] To: ${to} | Subject: ${subject}\n${text}`);
      return;
    }
    await transporter.sendMail({
      from: this.fromHeader(),
      to,
      subject,
      html,
      text,
    });
  }

  // ──────────────────────────────────────────────────────────
  // Verification email
  // ──────────────────────────────────────────────────────────
  async sendVerificationEmail(email: string, firstName: string, token: string): Promise<void> {
    const link = `${env.app.url}/api/${env.apiVersion}/auth/verify-email?token=${encodeURIComponent(
      token
    )}`;

    const subject = 'Bitte bestätige deine E-Mail-Adresse';
    const text =
      `Hallo ${firstName},\n\n` +
      `willkommen bei ${env.app.name}!\n\n` +
      `Bitte bestätige deine E-Mail-Adresse über folgenden Link:\n${link}\n\n` +
      `Der Link ist 24 Stunden gültig.\n\n` +
      `Falls du dich nicht registriert hast, ignoriere diese E-Mail einfach.\n\n` +
      `– Dein ${env.app.name}-Team`;

    const safeName = escapeHtml(firstName);
    const safeAppName = escapeHtml(env.app.name);
    const safeLink = escapeHtml(link);
    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #111;">
        <h1 style="color:#065B66; margin-bottom: 12px;">Willkommen bei ${safeAppName} 🎾</h1>
        <p>Hallo ${safeName},</p>
        <p>vielen Dank für deine Registrierung. Bitte bestätige deine E-Mail-Adresse, um dein Konto vollständig zu aktivieren:</p>
        <p style="text-align:center; margin: 32px 0;">
          <a href="${safeLink}" style="background:#065B66; color:#fff; text-decoration:none; padding: 14px 28px; border-radius: 8px; display:inline-block; font-weight:600;">E-Mail bestätigen</a>
        </p>
        <p style="font-size:12px; color:#666;">Der Link ist 24 Stunden gültig. Falls der Button nicht funktioniert, kopiere folgende URL in deinen Browser:<br>${safeLink}</p>
        <p style="font-size:12px; color:#666;">Falls du dich nicht registriert hast, ignoriere diese E-Mail einfach.</p>
      </div>
    `;

    await this.send(email, subject, html, text);
  }

  // ──────────────────────────────────────────────────────────
  // Password reset email
  // ──────────────────────────────────────────────────────────
  async sendPasswordResetEmail(
    email: string,
    firstName: string,
    token: string
  ): Promise<void> {
    const link = `${env.app.url}/reset-password?token=${encodeURIComponent(token)}`;

    const subject = 'Passwort zurücksetzen';
    const text =
      `Hallo ${firstName},\n\n` +
      `du hast eine Passwort-Zurücksetzung angefordert. Klicke auf den Link, um ein neues Passwort zu vergeben:\n${link}\n\n` +
      `Der Link ist 1 Stunde gültig.\n\n` +
      `Falls du das nicht warst, kannst du diese E-Mail ignorieren.\n\n` +
      `– Dein ${env.app.name}-Team`;

    const safeName = escapeHtml(firstName);
    const safeLink = escapeHtml(link);
    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #111;">
        <h1 style="color:#065B66; margin-bottom: 12px;">Passwort zurücksetzen</h1>
        <p>Hallo ${safeName},</p>
        <p>du hast eine Zurücksetzung deines Passworts angefordert. Klicke auf den Button, um ein neues Passwort zu vergeben:</p>
        <p style="text-align:center; margin: 32px 0;">
          <a href="${safeLink}" style="background:#065B66; color:#fff; text-decoration:none; padding: 14px 28px; border-radius: 8px; display:inline-block; font-weight:600;">Passwort zurücksetzen</a>
        </p>
        <p style="font-size:12px; color:#666;">Der Link ist 1 Stunde gültig. Falls der Button nicht funktioniert, nutze folgende URL:<br>${safeLink}</p>
        <p style="font-size:12px; color:#666;">Falls du das nicht warst, kannst du diese E-Mail ignorieren.</p>
      </div>
    `;

    await this.send(email, subject, html, text);
  }

  // ──────────────────────────────────────────────────────────
  // Registration confirmation
  // ──────────────────────────────────────────────────────────
  async sendRegistrationConfirmation(
    email: string,
    firstName: string,
    eventTitle: string,
    eventDate: string
  ): Promise<void> {
    const subject = `Anmeldung bestätigt: ${eventTitle}`;
    const text =
      `Hallo ${firstName},\n\n` +
      `deine Anmeldung für "${eventTitle}" am ${eventDate} wurde bestätigt.\n\n` +
      `Wir freuen uns auf dich!\n\n` +
      `– Dein ${env.app.name}-Team`;

    const safeName = escapeHtml(firstName);
    const safeTitle = escapeHtml(eventTitle);
    const safeDate = escapeHtml(eventDate);
    const safeAppName = escapeHtml(env.app.name);
    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #111;">
        <h1 style="color:#065B66; margin-bottom: 12px;">Du bist dabei! 🎉</h1>
        <p>Hallo ${safeName},</p>
        <p>deine Anmeldung für <strong>${safeTitle}</strong> am <strong>${safeDate}</strong> wurde erfolgreich bestätigt.</p>
        <p>Wir freuen uns auf dich!</p>
        <p style="font-size:12px; color:#666; margin-top: 32px;">– Dein ${safeAppName}-Team</p>
      </div>
    `;

    await this.send(email, subject, html, text);
  }
}

export const emailService = new EmailService();
