import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  userFindUnique,
  userCreate,
  checkEmailBannedMock,
  createTokenMock,
  sendVerificationEmailMock,
  isRegistrationEnabledMock,
  isAdminEmailMock,
  resolveRequestLocaleMock,
} = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userCreate: vi.fn(),
  checkEmailBannedMock: vi.fn(),
  createTokenMock: vi.fn(),
  sendVerificationEmailMock: vi.fn(),
  isRegistrationEnabledMock: vi.fn(),
  isAdminEmailMock: vi.fn(),
  resolveRequestLocaleMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: userFindUnique, create: userCreate } },
}));
vi.mock("@/lib/moderation", () => ({ checkEmailBanned: checkEmailBannedMock }));
vi.mock("@/lib/tokens", () => ({ createToken: createTokenMock }));
vi.mock("@/lib/mail", () => ({ sendVerificationEmail: sendVerificationEmailMock }));
vi.mock("@/lib/registration", () => ({ isRegistrationEnabled: isRegistrationEnabledMock }));
vi.mock("@/lib/admin-emails", () => ({ isAdminEmail: isAdminEmailMock }));
vi.mock("@/lib/i18n-server", () => ({
  getErrorT: async () => (key: string) => key,
  // Deliberately not "de": that is the default locale and the fallback in both
  // resolveRequestLocale and mail.ts's resolveLocale, so the assertion below
  // would still pass if the route dropped the locale on the floor.
  resolveRequestLocale: resolveRequestLocaleMock,
}));

import { POST } from "./route";

const VALID = { email: "New@Example.com", password: "correct horse", termsAccepted: true };

function callPost(body: unknown) {
  return POST(
    new Request("http://test/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  isRegistrationEnabledMock.mockReturnValue(true);
  isAdminEmailMock.mockReturnValue(false);
  checkEmailBannedMock.mockResolvedValue(false);
  userFindUnique.mockResolvedValue(null);
  userCreate.mockResolvedValue({ id: "user-1" });
  createTokenMock.mockResolvedValue("tok");
  sendVerificationEmailMock.mockResolvedValue(undefined);
  resolveRequestLocaleMock.mockResolvedValue("it");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/register", () => {
  it("creates the account and sends the verification mail in the caller's language", async () => {
    const res = await callPost(VALID);
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({ ok: true, requiresVerification: true });
    // The half of #35 that lives on this route: the resolved locale has to reach
    // the mail, or the visitor gets a German mail for an English page.
    expect(sendVerificationEmailMock).toHaveBeenCalledWith("new@example.com", "tok", "it");
  });

  it("normalises the email and stores an unverified row with the accepted terms", async () => {
    await callPost(VALID);
    expect(userCreate.mock.calls[0][0]).toMatchObject({
      data: { email: "new@example.com", role: "USER", emailVerified: null },
    });
    expect(userCreate.mock.calls[0][0].data.termsAcceptedAt).toBeInstanceOf(Date);
  });

  it("stores the signup locale on the account, for mail nobody has triggered yet", async () => {
    // Every later mail whose recipient is this user rather than its requester —
    // an admin notification, a takedown notice — reads the column instead of a
    // request that has nothing to do with them.
    await callPost(VALID);
    expect(userCreate.mock.calls[0][0]).toMatchObject({ data: { locale: "it" } });
  });

  it("answers 403 when registration is switched off", async () => {
    isRegistrationEnabledMock.mockReturnValue(false);
    const res = await callPost(VALID);
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "registrationDisabled" });
    expect(userCreate).not.toHaveBeenCalled();
  });

  it("answers 400 to a body that is not JSON", async () => {
    const res = await POST(
      new Request("http://test/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "invalidRequest" });
  });

  it("refuses a signup that does not accept the terms", async () => {
    // The consent record the legal setup depends on — a scripted client that
    // omits the flag must not get an account.
    const res = await callPost({ ...VALID, termsAccepted: false });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "termsNotAccepted" });
    expect(userCreate).not.toHaveBeenCalled();
  });

  it("answers 403 for a banned email", async () => {
    checkEmailBannedMock.mockResolvedValue(true);
    const res = await callPost(VALID);
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "emailBanned" });
    expect(userCreate).not.toHaveBeenCalled();
  });

  it("answers 409 for an email that already has a row", async () => {
    userFindUnique.mockResolvedValue({ id: "user-0" });
    const res = await callPost(VALID);
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: "emailRegistered" });
    expect(userCreate).not.toHaveBeenCalled();
  });

  it("reports a failed verification mail as a translated error, not an opaque 500", async () => {
    // The row exists by now, so a retry only yields the 409 — the caller has to
    // learn that the mail is what failed.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    sendVerificationEmailMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await callPost(VALID);

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "verificationEmailFailed" });
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("user-1"), expect.any(Error));
  });

  it("does not blame the mail for a locale that could not be resolved", async () => {
    // resolveRequestLocale is deliberately outside the try: a fault there is not
    // a delivery failure, and reporting it as one sends the operator to the SMTP
    // logs for a bug that never reached them.
    resolveRequestLocaleMock.mockRejectedValue(new Error("called outside a request scope"));

    await expect(callPost(VALID)).rejects.toThrow("called outside a request scope");
    expect(sendVerificationEmailMock).not.toHaveBeenCalled();
  });
});
