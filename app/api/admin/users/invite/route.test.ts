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
  // The route logs every invite it sends; silence it unless a test asserts on it.
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
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
    // A hash means the account can be logged into — activated through an invite,
    // self-registered, created by an admin or by scripts/create-user.mjs, it does
    // not matter which. Re-inviting would mint a password-setting link for an
    // account somebody is using.
    userFindUnique.mockResolvedValue({ id: "user-0", passwordHash: "$2b$hash", role: "USER" });
    const res = await callPost({ email: "taken@example.com" });
    expect(res.status).toBe(409);
    expect(userCreate).not.toHaveBeenCalled();
    expect(sendInviteEmailMock).not.toHaveBeenCalled();
  });

  it("asks for the hash it branches on, not just the id", async () => {
    // The whole feature hangs off this select. Narrow it to { id: true } — the
    // obvious "we only need the id" cleanup — and `existing.passwordHash` is
    // undefined, `undefined !== null` is true, and every invite to an address
    // that already has a row answers 409 again, with every other test still
    // green.
    await callPost({ email: "New@Example.com" });
    expect(userFindUnique).toHaveBeenCalledWith({
      where: { email: "new@example.com" },
      select: { id: true, passwordHash: true, role: true },
    });
  });

  describe("a row that never activated", () => {
    // passwordHash === null: the first invite's mail failed, the token expired
    // before it was redeemed, or — the common case — the invitee has not clicked
    // yet and their link is still live. The row cannot log in and it occupies the
    // address globally, so this used to be recoverable only by deleting the
    // account.
    const ORPHAN = { id: "user-0", passwordHash: null, role: "USER" };

    it("sends a fresh invite instead of answering 409", async () => {
      userFindUnique.mockResolvedValue(ORPHAN);

      const res = await callPost({ email: "invited@example.com" });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ ok: true, reinvited: true });
      expect(sendInviteEmailMock).toHaveBeenCalledWith("invited@example.com", "tok", "it");
    });

    it("reuses the existing row rather than creating a second one", async () => {
      // A create would fail on the unique email anyway. Reusing the row is what
      // makes this a re-invite rather than the old 409, and it keeps `createdAt`,
      // so the admin list still shows how long the address has been stuck.
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
      revokeTokensMock.mockResolvedValue(1);
      sendInviteEmailMock.mockRejectedValue(new Error("ECONNREFUSED"));

      const res = await callPost({ email: "invited@example.com" });

      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toEqual({ error: "inviteEmailFailed" });
      // How many links were revoked before it failed is the fact that decides
      // what the admin owes the invitee: past a successful revoke the account has
      // no working link, where a moment earlier it may have had one.
      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining("after revoking 1 link(s)"),
        expect.any(Error),
      );
    });

    it("keeps the old link and says so when the revoke fails", async () => {
      // Nothing was sent and the earlier link — quite possibly still valid — is
      // untouched, so this is not a delivery failure and must not be reported as
      // one: the two states need opposite instructions to the invitee.
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      userFindUnique.mockResolvedValue(ORPHAN);
      revokeTokensMock.mockRejectedValue(new Error("permission denied for table"));

      const res = await callPost({ email: "invited@example.com" });

      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toEqual({ error: "inviteRevokeFailed" });
      expect(createTokenMock).not.toHaveBeenCalled();
      expect(sendInviteEmailMock).not.toHaveBeenCalled();
      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining("still works"),
        expect.any(Error),
      );
    });

    it("logs the re-invite, because nothing else records the revoked link", async () => {
      // consumeToken does not log a refused claim, so without this an invitee
      // reporting a dead link is indistinguishable from an expired, purged or
      // already-claimed one.
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      userFindUnique.mockResolvedValue(ORPHAN);
      revokeTokensMock.mockResolvedValue(1);

      await callPost({ email: "invited@example.com" });

      expect(info).toHaveBeenCalledWith(expect.stringContaining("re-invited user user-0"));
      expect(info).toHaveBeenCalledWith(expect.stringContaining("1 previous link(s) revoked"));
      // The address is personal data and the admin list already maps it to the id.
      expect(info.mock.calls.flat().join(" ")).not.toContain("invited@example.com");
    });

    it("warns when more than one live link existed", async () => {
      // The condition revokeTokens exists to end. The route observes it and it is
      // visible nowhere else.
      const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
      userFindUnique.mockResolvedValue(ORPHAN);
      revokeTokensMock.mockResolvedValue(2);

      await callPost({ email: "invited@example.com" });

      expect(warned).toHaveBeenCalledWith(expect.stringContaining("held 2 live INVITE links"));
    });

    it("warns when the row being re-invited is an admin", async () => {
      // The button is offered — an invited admin who never activated is as stuck
      // as anyone else — but the link sets an administrator's password.
      const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
      userFindUnique.mockResolvedValue({ ...ORPHAN, role: "ADMIN" });

      const res = await callPost({ email: "invited@example.com" });

      expect(res.status).toBe(200);
      expect(warned).toHaveBeenCalledWith(expect.stringContaining("role ADMIN"));
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
    // `reinvited: false` as well as the 201: the status and the flag are derived
    // separately, and the admin UI words the flash off the flag alone. Left
    // unpinned, a first invitation can start announcing itself as a re-invite,
    // telling the admin the address was already in the system when it was not.
    await expect(res.json()).resolves.toEqual({ ok: true, reinvited: false });
    expect(sendInviteEmailMock).toHaveBeenCalledWith("new@example.com", "tok", "it");
  });

  it("has nothing to revoke for a brand-new row", async () => {
    // The documented contract of the `if (reinvited)` guard: registration mints
    // the first token for a fresh row, so a delete would be a no-op query on a
    // path that runs for every invitation.
    await callPost({ email: "new@example.com" });
    expect(revokeTokensMock).not.toHaveBeenCalled();
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
