// Transactional email via SMTP (nodemailer). In dev this points at the Mailpit
// container (which captures everything); in prod set the SMTP_* env to a real
// server. Links are built from APP_URL. Subject/body are localized via the
// `email` message namespace; the locale is passed in by the API route (read
// from the caller's NEXT_LOCALE cookie).

import nodemailer from "nodemailer";
import { getTranslations } from "next-intl/server";
import { routing, type Locale } from "@/i18n/routing";

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

function resolveLocale(locale?: string): Locale {
  return routing.locales.includes(locale as Locale) ? (locale as Locale) : routing.defaultLocale;
}

// Links are locale-prefixed so the confirmation/invite page opens in the same
// language the account was created in.
export function verifyUrl(token: string, locale: Locale): string {
  return `${appUrl()}/${locale}/verify?token=${encodeURIComponent(token)}`;
}

export function inviteUrl(token: string, locale: Locale): string {
  return `${appUrl()}/${locale}/invite?token=${encodeURIComponent(token)}`;
}

export async function sendVerificationEmail(
  to: string,
  token: string,
  locale?: string,
): Promise<void> {
  const loc = resolveLocale(locale);
  const t = await getTranslations({ locale: loc, namespace: "email" });
  const url = verifyUrl(token, loc);
  await transport().sendMail({
    from: FROM,
    to,
    subject: t("verifySubject"),
    text: `${t("verifyIntro")}\n\n${t("verifyAction")}\n${url}\n\n${t("verifyExpiry")}`,
    html: `<p>${t("verifyIntro")}</p><p>${t("verifyAction")}</p><p><a href="${url}">${url}</a></p><p>${t("verifyExpiry")}</p>`,
  });
}

export async function sendInviteEmail(
  to: string,
  token: string,
  locale?: string,
): Promise<void> {
  const loc = resolveLocale(locale);
  const t = await getTranslations({ locale: loc, namespace: "email" });
  const url = inviteUrl(token, loc);
  await transport().sendMail({
    from: FROM,
    to,
    subject: t("inviteSubject"),
    text: `${t("inviteIntro")}\n\n${t("inviteAction")}\n${url}\n\n${t("inviteExpiry")}`,
    html: `<p>${t("inviteIntro")}</p><p>${t("inviteAction")}</p><p><a href="${url}">${url}</a></p><p>${t("inviteExpiry")}</p>`,
  });
}
