// Transactional email via SMTP (nodemailer). In dev this points at the Mailpit
// container (which captures everything); in prod set the SMTP_* env to a real
// server. Links are built from APP_URL.

import nodemailer from "nodemailer";

function transport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST ?? "mailpit",
    port: Number(process.env.SMTP_PORT ?? 1025),
    secure: (process.env.SMTP_SECURE ?? "false") === "true",
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? "" }
      : undefined,
  });
}

const FROM = process.env.SMTP_FROM ?? "Jigsaw <no-reply@jigsaw.local>";

function appUrl(): string {
  return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

export function verifyUrl(token: string): string {
  return `${appUrl()}/verify?token=${encodeURIComponent(token)}`;
}

export function inviteUrl(token: string): string {
  return `${appUrl()}/invite?token=${encodeURIComponent(token)}`;
}

export async function sendVerificationEmail(to: string, token: string): Promise<void> {
  const url = verifyUrl(token);
  await transport().sendMail({
    from: FROM,
    to,
    subject: "Bestätige deine E-Mail — Jigsaw",
    text: `Willkommen bei Jigsaw!\n\nBitte bestätige deine E-Mail-Adresse:\n${url}\n\nDer Link ist 24 Stunden gültig.`,
    html: `<p>Willkommen bei Jigsaw!</p><p>Bitte bestätige deine E-Mail-Adresse:</p><p><a href="${url}">${url}</a></p><p>Der Link ist 24 Stunden gültig.</p>`,
  });
}

export async function sendInviteEmail(to: string, token: string): Promise<void> {
  const url = inviteUrl(token);
  await transport().sendMail({
    from: FROM,
    to,
    subject: "Du wurdest zu Jigsaw eingeladen",
    text: `Du wurdest zu Jigsaw eingeladen.\n\nSetze dein Passwort und aktiviere dein Konto:\n${url}\n\nDer Link ist 7 Tage gültig.`,
    html: `<p>Du wurdest zu Jigsaw eingeladen.</p><p>Setze dein Passwort und aktiviere dein Konto:</p><p><a href="${url}">${url}</a></p><p>Der Link ist 7 Tage gültig.</p>`,
  });
}
