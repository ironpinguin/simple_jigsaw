import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  requireAdminMock,
  userFindUnique,
  userCreate,
  checkEmailBannedMock,
  createTokenMock,
  revokeTokensMock,
  sendInviteEmailMock,
} = vi.hoisted(() => ({
  requireAdminMock: vi.fn(),
  userFindUnique: vi.fn(),
  userCreate: vi.fn(),
  checkEmailBannedMock: vi.fn(),
  createTokenMock: vi.fn(),
  revokeTokensMock: vi.fn(),
  sendInviteEmailMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ requireAdmin: requireAdminMock }));
vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: userFindUnique, create: userCreate } },
}));
vi.mock("@/lib/moderation", () => ({ checkEmailBanned: checkEmailBannedMock }));
vi.mock("@/lib/tokens", () => ({
  createToken: createTokenMock,
  revokeTokens: revokeTokensMock,
}));
vi.mock("@/lib/mail", () => ({ sendInviteEmail: sendInviteEmailMock }));
vi.mock("@/lib/i18n-server", () => ({
  getErrorT: async () => (key: string) => key,
  // Deliberately not "de": that is the default locale and the fallback in both
  // resolveRequestLocale and mail.ts's resolveLocale, so the assertion would
  // still pass if the route dropped the locale on the floor.
  resolveRequestLocale: async () => "it",
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
  revokeTokensMock.mockResolvedValue(0);
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

  it("answers 409 for an email that belongs to a usable account", async () => {
    // A password means somebody activated it. Re-inviting would mint a
    // password-setting link for an account in use.
    userFindUnique.mockResolvedValue({ id: "user-0", passwordHash: "$2b$hash" });
    const res = await callPost({ email: "taken@example.com" });
    expect(res.status).toBe(409);
    expect(userCreate).not.toHaveBeenCalled();
    expect(sendInviteEmailMock).not.toHaveBeenCalled();
  });

  describe("a row that never activated", () => {
    // passwordHash === null: the first invite's mail failed, or the token expired
    // before it was redeemed. The row cannot log in and it occupies the address
    // globally, so this used to be recoverable only by deleting the account.
    const ORPHAN = { id: "user-0", passwordHash: null };

    it("sends a fresh invite instead of answering 409", async () => {
      userFindUnique.mockResolvedValue(ORPHAN);

      const res = await callPost({ email: "invited@example.com" });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ ok: true, reinvited: true });
      expect(sendInviteEmailMock).toHaveBeenCalledWith("invited@example.com", "tok", "it");
    });

    it("reuses the existing row rather than creating a second one", async () => {
      // A create would fail on the unique email anyway; the point is that the
      // invitee keeps the id anything else already references.
      userFindUnique.mockResolvedValue(ORPHAN);

      await callPost({ email: "invited@example.com" });

      expect(userCreate).not.toHaveBeenCalled();
      expect(createTokenMock).toHaveBeenCalledWith("user-0", "INVITE");
    });

    it("revokes the previous link before minting the new one", async () => {
      // Otherwise both mails work, and an invite is a password-setting link:
      // whoever still holds the older one can set the password too.
      userFindUnique.mockResolvedValue(ORPHAN);

      await callPost({ email: "invited@example.com" });

      expect(revokeTokensMock).toHaveBeenCalledWith("user-0", "INVITE");
      expect(revokeTokensMock.mock.invocationCallOrder[0]).toBeLessThan(
        createTokenMock.mock.invocationCallOrder[0],
      );
    });

    it("reports a failed re-invite mail the way the create path does", async () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      userFindUnique.mockResolvedValue(ORPHAN);
      sendInviteEmailMock.mockRejectedValue(new Error("ECONNREFUSED"));

      const res = await callPost({ email: "invited@example.com" });

      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toEqual({ error: "inviteEmailFailed" });
      expect(logged).toHaveBeenCalled();
    });

    it("does not leave the account without a link when the revoke fails", async () => {
      // The old link is either still valid or already gone, but no new mail went
      // out — so this must not read as a sent invitation.
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      userFindUnique.mockResolvedValue(ORPHAN);
      revokeTokensMock.mockRejectedValue(new Error("db down"));

      const res = await callPost({ email: "invited@example.com" });

      expect(res.status).toBe(500);
      expect(createTokenMock).not.toHaveBeenCalled();
      expect(sendInviteEmailMock).not.toHaveBeenCalled();
      expect(logged).toHaveBeenCalled();
    });

    it("still refuses a banned address", async () => {
      // The ban check sits before all of this, and a never-activated row must not
      // become a way around it.
      userFindUnique.mockResolvedValue(ORPHAN);
      checkEmailBannedMock.mockResolvedValue(true);

      const res = await callPost({ email: "invited@example.com" });

      expect(res.status).toBe(403);
      expect(sendInviteEmailMock).not.toHaveBeenCalled();
    });
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
