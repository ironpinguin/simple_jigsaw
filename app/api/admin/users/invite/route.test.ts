import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requireAdminMock, userFindUnique, userCreate, checkEmailBannedMock, createTokenMock, sendInviteEmailMock } =
  vi.hoisted(() => ({
    requireAdminMock: vi.fn(),
    userFindUnique: vi.fn(),
    userCreate: vi.fn(),
    checkEmailBannedMock: vi.fn(),
    createTokenMock: vi.fn(),
    sendInviteEmailMock: vi.fn(),
  }));

vi.mock("@/lib/auth", () => ({ requireAdmin: requireAdminMock }));
vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: userFindUnique, create: userCreate } },
}));
vi.mock("@/lib/moderation", () => ({ checkEmailBanned: checkEmailBannedMock }));
vi.mock("@/lib/tokens", () => ({ createToken: createTokenMock }));
vi.mock("@/lib/mail", () => ({ sendInviteEmail: sendInviteEmailMock }));
vi.mock("@/lib/i18n-server", () => ({
  getErrorT: async () => (key: string) => key,
  // Deliberately not "de": that is both the default locale and the fallback
  // inside resolveLocale, so it would still pass if the cookie were ignored.
  localeFromCookie: async () => "it",
}));

import { POST } from "./route";

function callPost(body: unknown) {
  return POST(
    new Request("http://test/api/admin/users/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdminMock.mockResolvedValue({ id: "admin-1", email: "a@example.com", role: "ADMIN" });
  checkEmailBannedMock.mockResolvedValue(false);
  userFindUnique.mockResolvedValue(null);
  userCreate.mockResolvedValue({ id: "user-1" });
  createTokenMock.mockResolvedValue("tok");
  sendInviteEmailMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/admin/users/invite", () => {
  it("answers 403 to a non-admin", async () => {
    requireAdminMock.mockResolvedValue(null);
    const res = await callPost({ email: "new@example.com" });
    expect(res.status).toBe(403);
    expect(userCreate).not.toHaveBeenCalled();
  });

  it("answers 409 for an email that already has a row", async () => {
    userFindUnique.mockResolvedValue({ id: "user-0" });
    const res = await callPost({ email: "taken@example.com" });
    expect(res.status).toBe(409);
    expect(userCreate).not.toHaveBeenCalled();
  });

  it("creates the row and sends the invite", async () => {
    const res = await callPost({ email: "New@Example.com" });
    expect(res.status).toBe(201);
    expect(sendInviteEmailMock).toHaveBeenCalledWith("new@example.com", "tok", "it");
  });

  it("creates a password-less, unverified USER row", async () => {
    // What makes this an invite rather than an account: without these three the
    // form would mint a usable — possibly pre-verified or privileged — login.
    await callPost({ email: "new@example.com" });
    expect(userCreate.mock.calls[0][0]).toMatchObject({
      data: { email: "new@example.com", passwordHash: null, role: "USER", emailVerified: null },
    });
  });

  it("mints an INVITE token for the new row", async () => {
    // A wrong kind still sends a mail, but consumeToken rejects the link on
    // arrival and the invitee is stuck with no visible cause.
    await callPost({ email: "new@example.com" });
    expect(createTokenMock).toHaveBeenCalledWith("user-1", "INVITE");
  });

  it("reports a failed invite mail as a translated error, not an opaque 500", async () => {
    // The row is already created at this point, so the admin must learn that the
    // mail failed rather than seeing an unhandled throw.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    sendInviteEmailMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await callPost({ email: "new@example.com" });

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "inviteEmailFailed" });
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining("user-1"),
      expect.any(Error),
    );
  });

  it("reports a failed token creation the same way", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    createTokenMock.mockRejectedValue(new Error("db down"));

    const res = await callPost({ email: "new@example.com" });

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "inviteEmailFailed" });
    expect(sendInviteEmailMock).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalled();
  });
});
