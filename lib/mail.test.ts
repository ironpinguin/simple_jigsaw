import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendMailMock } = vi.hoisted(() => ({ sendMailMock: vi.fn() }));

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: sendMailMock }) },
}));

// The real catalogs with minimal ICU interpolation; unknown keys throw, exactly
// like next-intl — that is the failure mode the category guard protects. The
// locale is honoured rather than ignored, because which catalog a sender picks
// is itself under test: the recipient's language is not the requester's.
const CATALOGS: Record<string, () => Promise<{ default: unknown }>> = {
  de: () => import("@/messages/de.json"),
  en: () => import("@/messages/en.json"),
  it: () => import("@/messages/it.json"),
};

vi.mock("next-intl/server", () => ({
  getTranslations: async ({ locale, namespace }: { locale: string; namespace: string }) => {
    const load = CATALOGS[locale];
    if (!load) throw new Error(`no catalog for locale ${locale}`);
    const messages = (await load()).default as unknown as Record<string, Record<string, string>>;
    const ns = messages[namespace];
    return (key: string, values?: Record<string, string>) => {
      const template = ns?.[key];
      if (template === undefined) throw new Error(`missing translation key ${namespace}.${key}`);
      return template.replace(/\{(\w+)\}/g, (_, k: string) => values?.[k] ?? `{${k}}`);
    };
  },
}));

import {
  sendAutoReportNotification,
  sendPasswordResetEmail,
  sendReportNotification,
  sendTakedownNotice,
} from "./mail";

// Puzzle titles are user input interpolated into mail bodies — the escaping
// asserted here is the only thing between an owner-authored title like
// "<a href=…>click to review</a>" and phishing-shaped HTML in admin inboxes.
const HOSTILE_TITLE = `<img src=x onerror="alert(1)"> & "quotes"`;
const ESCAPED_TITLE = `&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &quot;quotes&quot;`;

beforeEach(() => {
  vi.clearAllMocks();
  sendMailMock.mockResolvedValue(undefined);
});

describe("sendReportNotification", () => {
  it("escapes the puzzle title in the HTML body but not in the text body", async () => {
    await sendReportNotification("admin@example.com", HOSTILE_TITLE, "NSFW", "en");
    const mail = sendMailMock.mock.calls[0][0];
    expect(mail.html).toContain(ESCAPED_TITLE);
    expect(mail.html).not.toContain(HOSTILE_TITLE);
    expect(mail.text).toContain(HOSTILE_TITLE);
  });

  it("labels the category with its translation", async () => {
    await sendReportNotification("admin@example.com", "Beach", "COPYRIGHT", "en");
    const mail = sendMailMock.mock.calls[0][0];
    expect(mail.text).toContain("Copyright infringement");
  });
});

describe("sendAutoReportNotification", () => {
  it("escapes the puzzle title in the HTML body but not in the text body", async () => {
    await sendAutoReportNotification("admin@example.com", HOSTILE_TITLE, "AUTO_NSFW", "en");
    const mail = sendMailMock.mock.calls[0][0];
    expect(mail.html).toContain(ESCAPED_TITLE);
    expect(mail.html).not.toContain(HOSTILE_TITLE);
    expect(mail.text).toContain(HOSTILE_TITLE);
  });

  it("does not tell the admin somebody reported the puzzle", async () => {
    // The whole reason this exists rather than reusing sendReportNotification:
    // /api/puzzles files this finding with no reporter at all, deliberately, so
    // a mail saying it "was reported" would attribute a judgement to a person
    // who never made one. Same reasoning as takedownIntroNoReport.
    await sendAutoReportNotification("admin@example.com", "Beach", "AUTO_NSFW", "en");
    const mail = sendMailMock.mock.calls[0][0];
    expect(mail.subject).not.toMatch(/reported/i);
    expect(mail.text).not.toMatch(/was reported/i);
    expect(mail.text).toMatch(/automatic check/i);
  });

  it("labels the category and links the queue", async () => {
    await sendAutoReportNotification("admin@example.com", "Beach", "AUTO_NSFW", "en");
    const mail = sendMailMock.mock.calls[0][0];
    expect(mail.text).toContain("Explicit content");
    expect(mail.text).toContain("/en/admin/reports");
  });
});

// The acceptance criterion of #31, and the reason the locale column exists:
// these three senders mail somebody who is not the person making the request,
// so until the recipient's own language could be looked up they all went out in
// the default one. A pass here with the mock above ignoring `locale` would be
// worthless, which is why that mock resolves a real catalog per locale.
describe("recipient locale", () => {
  it("writes a report notification in the admin's language", async () => {
    await sendReportNotification("admin@example.com", "Beach", "NSFW", "it");
    expect(sendMailMock.mock.calls[0][0].subject).toBe("Un puzzle è stato segnalato");
  });

  it("writes an automatic report notification in the admin's language", async () => {
    await sendAutoReportNotification("admin@example.com", "Beach", "AUTO_NSFW", "en");
    expect(sendMailMock.mock.calls[0][0].subject).toBe("A puzzle was held by the automatic check");
  });

  it("writes a takedown notice in the owner's language", async () => {
    await sendTakedownNotice("owner@example.com", "Beach", "NSFW", "it");
    expect(sendMailMock.mock.calls[0][0].subject).toBe("Il tuo puzzle è stato rimosso");
  });

  it("falls back to the default locale for a row that predates the column", async () => {
    // `undefined` is what a pre-column account resolves to if a caller ever
    // reads one before the default is applied — it must not throw, and it must
    // keep today's behaviour rather than picking the last locale used.
    await sendTakedownNotice("owner@example.com", "Beach", "NSFW", undefined);
    expect(sendMailMock.mock.calls[0][0].subject).toBe("Dein Puzzle wurde entfernt");
  });

  it("falls back to the default locale for a value that is not a known locale", async () => {
    // The column is a plain String on both providers — nothing at the database
    // level stops a hand-edited row from holding "fr".
    await sendTakedownNotice("owner@example.com", "Beach", "NSFW", "fr");
    expect(sendMailMock.mock.calls[0][0].subject).toBe("Dein Puzzle wurde entfernt");
  });
});

describe("sendTakedownNotice", () => {
  it("escapes the puzzle title in the HTML body but not in the text body", async () => {
    await sendTakedownNotice("owner@example.com", HOSTILE_TITLE, "NSFW", "en");
    const mail = sendMailMock.mock.calls[0][0];
    expect(mail.html).toContain(ESCAPED_TITLE);
    expect(mail.html).not.toContain(HOSTILE_TITLE);
    expect(mail.text).toContain(HOSTILE_TITLE);
  });

  it("cites the reported category when one exists", async () => {
    await sendTakedownNotice("owner@example.com", "Beach", "ILLEGAL", "en");
    const mail = sendMailMock.mock.calls[0][0];
    expect(mail.text).toContain("Violence or illegal content");
  });

  it("cites a review instead of a category when none exists", async () => {
    await sendTakedownNotice("owner@example.com", "Beach", null, "en");
    const mail = sendMailMock.mock.calls[0][0];
    expect(mail.text).toBe("Your puzzle “Beach” was removed by an administrator after a review.");
  });

  it("includes machine-generated categories in the takedown notice", async () => {
    await sendTakedownNotice("owner@example.com", "Beach", "AUTO_NSFW", "en");
    const mail = sendMailMock.mock.calls[0][0];
    expect(mail.text).toContain("Beach");
    expect(mail.text).toContain("removed");
  });
});

describe("sendPasswordResetEmail", () => {
  it("sends a reset link on the recipient's locale prefix", async () => {
    await sendPasswordResetEmail("someone@example.com", "tok-123", "it");
    const sent = sendMailMock.mock.calls[0][0];

    expect(sent.to).toBe("someone@example.com");
    expect(sent.text).toContain("/it/reset?token=tok-123");
    expect(sent.html).toContain("/it/reset?token=tok-123");
  });

  it("never states whether the address has an account", async () => {
    // The request endpoint answers identically for unknown addresses; a mail
    // that said "your account" would give away what the endpoint withholds —
    // to anyone who can read the recipient's inbox.
    await sendPasswordResetEmail("someone@example.com", "tok-123", "en");
    const sent = sendMailMock.mock.calls[0][0];

    expect(sent.text).toContain("Someone asked to reset the password");
    expect(sent.text).toContain("you can ignore this email");
  });
});
