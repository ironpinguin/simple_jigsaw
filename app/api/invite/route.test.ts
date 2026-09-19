import { beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import { TERMS_VERSION } from "@/lib/legal";

const { userFindUnique, userUpdate, consumeTokenMock, checkEmailBannedMock, resolveRequestLocaleMock } =
  vi.hoisted(() => ({
    userFindUnique: vi.fn(),
    userUpdate: vi.fn(),
    consumeTokenMock: vi.fn(),
    checkEmailBannedMock: vi.fn(),
    resolveRequestLocaleMock: vi.fn(),
  }));

vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: userFindUnique, update: userUpdate } },
}));
vi.mock("@/lib/tokens", () => ({ consumeToken: consumeTokenMock }));
vi.mock("@/lib/moderation", () => ({ checkEmailBanned: checkEmailBannedMock }));
// The key rather than the translation: these assertions are about which message
// the route picks, and pinning the German copy would break on any rewording.
// Deliberately not "de": that is the default locale and the fallback in both
// resolveRequestLocale and mail.ts's resolveLocale, so the locale assertion
// below would still pass if the route dropped it on the floor.
vi.mock("@/lib/i18n-server", () => ({
  getErrorT: async () => (key: string) => key,
  resolveRequestLocale: resolveRequestLocaleMock,
}));

import { POST } from "./route";

const VALID = { token: "tok", password: "correct horse", termsAccepted: true };

function callPost(body: unknown) {
  return POST(
    new Request("http://test/api/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  consumeTokenMock.mockResolvedValue({ ok: true, userId: "user-1" });
  userFindUnique.mockResolvedValue({ id: "user-1", email: "invited@example.com" });
  checkEmailBannedMock.mockResolvedValue(false);
  userUpdate.mockResolvedValue({});
  resolveRequestLocaleMock.mockResolvedValue("it");
});

describe("POST /api/invite", () => {
  it("stores the activation locale on the account", async () => {
    // The invite itself was sent in whatever language the *admin* was browsing
    // in; activation is the first moment the invitee's own is observable, so it
    // is the one chance to record it before anybody mails them unprompted.
    await callPost(VALID);
    expect(userUpdate.mock.calls[0][0]).toMatchObject({ data: { locale: "it" } });
  });

  it("sets the password and activates the account when the token is claimed", async () => {
    const res = await callPost(VALID);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(consumeTokenMock).toHaveBeenCalledWith("tok", "INVITE");

    const { where, data } = userUpdate.mock.calls[0][0];
    expect(where).toEqual({ id: "user-1" });
    expect(data).toMatchObject({ termsVersion: TERMS_VERSION });
    expect(data.emailVerified).toBeInstanceOf(Date);
    expect(data.termsAcceptedAt).toBeInstanceOf(Date);
    // The hash, never the password itself.
    expect(data.passwordHash).not.toBe(VALID.password);
    await expect(bcrypt.compare(VALID.password, data.passwordHash)).resolves.toBe(true);
  });

  it("refuses an invalid link with a 400 and sets no password", async () => {
    consumeTokenMock.mockResolvedValue({ ok: false, reason: "invalid" });

    const res = await callPost(VALID);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "inviteInvalid" });
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("answers 503 when the claim could not be attempted", async () => {
    // A failed delete leaves the invite intact, so a retry may work — and this
    // is the route with no self-service resend, where wrongly calling the link
    // expired leaves an account only an admin can rescue.
    consumeTokenMock.mockResolvedValue({ ok: false, reason: "unavailable" });

    const res = await callPost(VALID);

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "linkUnavailable" });
  });

  it("sets no password when the claim could not be attempted", async () => {
    // This is what the whole fix is for, and until now it was asserted only in a
    // docstring. An invite is a password-setting link: if a token that was never
    // actually spent can still reach the update below, anyone holding a copy of
    // the mail can set the password again after the recipient has activated.
    consumeTokenMock.mockResolvedValue({ ok: false, reason: "unavailable" });

    await callPost(VALID);

    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("answers 404 when the invited account has gone", async () => {
    userFindUnique.mockResolvedValue(null);

    const res = await callPost(VALID);

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "accountNotFound" });
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("answers 403 and sets no password when the address has since been banned", async () => {
    checkEmailBannedMock.mockResolvedValue(true);

    const res = await callPost(VALID);

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "emailBanned" });
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("rejects a short password before claiming the token", async () => {
    // Claiming first would burn the invite on a typo, and there is no resend.
    const res = await callPost({ ...VALID, password: "short" });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "passwordMin" });
    expect(consumeTokenMock).not.toHaveBeenCalled();
  });

  it("rejects an activation that does not accept the terms", async () => {
    const res = await callPost({ ...VALID, termsAccepted: false });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "termsNotAccepted" });
    expect(consumeTokenMock).not.toHaveBeenCalled();
  });
});
