// Transactional email via SMTP (nodemailer). In dev this points at the Mailpit
// container (which captures everything); in prod set the SMTP_* env to a real
// server. Links are built from APP_URL. Subject/body are localized via the
// `email` message namespace; the locale is passed in by the API route (see
// resolveRequestLocale in lib/i18n-server.ts).

import nodemailer from "nodemailer";
import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import { routing, type Locale } from "@/i18n/routing";
import type { ReportCategory } from "./reports";

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

// `null` is a value the User.locale column actually holds — it means nobody has
// established that person's language — so it is accepted here alongside
// undefined and an unrecognised string, and all three land on the default.
function resolveLocale(locale?: string | null): Locale {
  const candidate = locale ?? undefined;
  return hasLocale(routing.locales, candidate) ? candidate : routing.defaultLocale;
}

// Links are locale-prefixed so the confirmation/invite page opens in the same
// language the account was created in.
export function verifyUrl(token: string, locale: Locale): string {
  return `${appUrl()}/${locale}/verify?token=${encodeURIComponent(token)}`;
}

export function inviteUrl(token: string, locale: Locale): string {
  return `${appUrl()}/${locale}/invite?token=${encodeURIComponent(token)}`;
}

export function resetUrl(token: string, locale: Locale): string {
  return `${appUrl()}/${locale}/reset?token=${encodeURIComponent(token)}`;
}

// Puzzle titles are user input and get interpolated into HTML bodies.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function sendVerificationEmail(
  to: string,
  token: string,
  locale?: string | null,
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
  locale?: string | null,
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

export async function sendPasswordResetEmail(
  to: string,
  token: string,
  locale?: string | null,
): Promise<void> {
  const loc = resolveLocale(locale);
  const t = await getTranslations({ locale: loc, namespace: "email" });
  const url = resetUrl(token, loc);
  await transport().sendMail({
    from: FROM,
    to,
    subject: t("resetSubject"),
    text: `${t("resetIntro")}\n\n${t("resetAction")}\n${url}\n\n${t("resetExpiry")}`,
    html: `<p>${t("resetIntro")}</p><p>${t("resetAction")}</p><p><a href="${url}">${url}</a></p><p>${t("resetExpiry")}</p>`,
  });
}

// Which locale a caller should pass depends on who the recipient is.
//
// Verification and reset mail the person who just typed their own address into
// a form, so the request locale is both available and correct. The three
// senders below never do: the recipient is an admin, or the reported puzzle's
// owner, and the acting user's language belongs to somebody else. Those callers
// read `User.locale` instead (lib/report-notify.ts,
// app/api/admin/puzzles/[id]/route.ts); it is a plain String on both providers,
// so an unknown value falls back to the default in resolveLocale above rather
// than throwing on a missing catalog.
//
// sendInviteEmail is the odd one out and stays on the request locale: its
// recipient is not the requester either — an admin types a colleague's address
// — but the row is brand new and holds nothing better to read. The invitee's
// own language is recorded when they activate, from Accept-Language rather than
// the cookie this very mail's link goes on to set (see resolveBrowserLocale).
export async function sendReportNotification(
  to: string,
  puzzleTitle: string,
  category: ReportCategory,
  locale?: string | null,
): Promise<void> {
  const loc = resolveLocale(locale);
  const t = await getTranslations({ locale: loc, namespace: "email" });
  const url = `${appUrl()}/${loc}/admin/reports`;
  const categoryLabel = t(`category${category}`);
  const text = t("reportIntro", { title: puzzleTitle, category: categoryLabel });
  const html = t("reportIntro", { title: escapeHtml(puzzleTitle), category: categoryLabel });
  await transport().sendMail({
    from: FROM,
    to,
    subject: t("reportSubject"),
    text: `${text}\n\n${t("reportAction")}\n${url}`,
    html: `<p>${html}</p><p>${t("reportAction")}</p><p><a href="${url}">${url}</a></p>`,
  });
}

/**
 * The machine counterpart to sendReportNotification, with its own subject and
 * intro rather than reusing that one's.
 *
 * `reportSubject`/`reportIntro` say the puzzle "was reported", and /api/puzzles
 * files this finding with no reporter at all — deliberately, because putting a
 * person's name on a judgement nobody made is worse than an extra string. Same
 * reasoning as takedownIntroNoReport below. `reportAction` is shared: both
 * point the admin at the same queue.
 */
export async function sendAutoReportNotification(
  to: string,
  puzzleTitle: string,
  category: ReportCategory,
  locale?: string | null,
): Promise<void> {
  const loc = resolveLocale(locale);
  const t = await getTranslations({ locale: loc, namespace: "email" });
  const url = `${appUrl()}/${loc}/admin/reports`;
  const categoryLabel = t(`category${category}`);
  const text = t("autoReportIntro", { title: puzzleTitle, category: categoryLabel });
  const html = t("autoReportIntro", { title: escapeHtml(puzzleTitle), category: categoryLabel });
  await transport().sendMail({
    from: FROM,
    to,
    subject: t("autoReportSubject"),
    text: `${text}\n\n${t("reportAction")}\n${url}`,
    html: `<p>${html}</p><p>${t("reportAction")}</p><p><a href="${url}">${url}</a></p>`,
  });
}

// category null = no canonical reported category exists (takedown without an
// open report): the notice then cites a review instead of inventing a reason.
export async function sendTakedownNotice(
  to: string,
  puzzleTitle: string,
  category: ReportCategory | null,
  locale?: string | null,
): Promise<void> {
  const loc = resolveLocale(locale);
  const t = await getTranslations({ locale: loc, namespace: "email" });
  const intro = (title: string) =>
    category
      ? t("takedownIntro", { title, category: t(`category${category}`) })
      : t("takedownIntroNoReport", { title });
  await transport().sendMail({
    from: FROM,
    to,
    subject: t("takedownSubject"),
    text: intro(puzzleTitle),
    html: `<p>${intro(escapeHtml(puzzleTitle))}</p>`,
  });
}
