import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendMailMock } = vi.hoisted(() => ({ sendMailMock: vi.fn() }));

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: sendMailMock }) },
}));

// Real EN catalog with minimal ICU interpolation; unknown keys throw, exactly
// like next-intl — that is the failure mode the category guard protects.
vi.mock("next-intl/server", () => ({
  getTranslations: async ({ namespace }: { namespace: string }) => {
    const messages = (await import("@/messages/en.json")).default as unknown as Record<
      string,
      Record<string, string>
    >;
    const ns = messages[namespace];
    return (key: string, values?: Record<string, string>) => {
      const template = ns?.[key];
      if (template === undefined) throw new Error(`missing translation key ${namespace}.${key}`);
      return template.replace(/\{(\w+)\}/g, (_, k: string) => values?.[k] ?? `{${k}}`);
    };
  },
}));

import { sendAutoReportNotification, sendReportNotification, sendTakedownNotice } from "./mail";

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
