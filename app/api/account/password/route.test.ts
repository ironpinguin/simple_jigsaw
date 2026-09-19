import { beforeEach, describe, expect, it, vi } from "vitest";

const { authMock, userFindUnique, userUpdate, compareMock, hashMock, revokeTokensMock } =
  vi.hoisted(() => ({
    authMock: vi.fn(),
    userFindUnique: vi.fn(),
    userUpdate: vi.fn(),
    compareMock: vi.fn(),
    hashMock: vi.fn(),
    revokeTokensMock: vi.fn(),
  }));

vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: userFindUnique, update: userUpdate } },
}));
vi.mock("@/lib/i18n-server", () => ({ getErrorT: async () => (key: string) => key }));
vi.mock("bcryptjs", () => ({ default: { compare: compareMock, hash: hashMock } }));
vi.mock("@/lib/tokens", () => ({ revokeTokens: revokeTokensMock }));

import { PUT } from "./route";

function call(body: unknown) {
  return PUT(
    new Request("http://test/api/account/password", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const VALID = { currentPassword: "oldpassword", newPassword: "newpassword" };

describe("PUT /api/account/password", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue({
      user: { id: "u1", email: "a@b.de", role: "USER" },
    });
    userFindUnique.mockResolvedValue({ id: "u1", passwordHash: "$2b$hash" });
    compareMock.mockResolvedValue(true);
    hashMock.mockResolvedValue("$2b$newhash");
    userUpdate.mockResolvedValue({});
  });

  it("refuses without a session, without touching the database", async () => {
    authMock.mockResolvedValue(null);
    const res = await call(VALID);
    expect(res.status).toBe(401);
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("refuses a wrong current password", async () => {
    // The session cookie alone must not be enough to change the password.
    compareMock.mockResolvedValue(false);
    const res = await call(VALID);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "wrongPassword" });
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("refuses a new password under the minimum", async () => {
    const res = await call({
      currentPassword: "oldpassword",
      newPassword: "short",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "passwordMin" });
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("refuses a new password past what bcrypt hashes", async () => {
    const res = await call({
      currentPassword: "oldpassword",
      newPassword: "a".repeat(100),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "passwordMax" });
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("does not answer a missing current password with the new password's rule", async () => {
    // A body with neither field fails on both; answering "at least 8
    // characters" names a rule the caller never broke.
    const res = await call({});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalidRequest" });
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("reads the user row once, on top of the lookup the session already made", async () => {
    await call(VALID);
    expect(userFindUnique).toHaveBeenCalledTimes(1);
  });

  it("refuses a body that is not an object", async () => {
    const res = await call(null);
    expect(res.status).toBe(400);
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("refuses a row with no hash without calling bcrypt.compare on null", async () => {
    // bcrypt.compare throws on a null hash; such a row cannot hold a session
    // anyway, so it gets the same answer as a wrong password.
    userFindUnique.mockResolvedValue({ id: "u1", passwordHash: null });
    const res = await call(VALID);
    expect(res.status).toBe(401);
    expect(compareMock).not.toHaveBeenCalled();
  });

  it("writes the new hash and stamps passwordChangedAt together", async () => {
    const res = await call(VALID);
    expect(res.status).toBe(200);

    expect(userUpdate).toHaveBeenCalledTimes(1);
    const args = userUpdate.mock.calls[0][0];
    expect(args.where).toEqual({ id: "u1" });
    expect(args.data.passwordHash).toBe("$2b$newhash");
    expect(args.data.passwordChangedAt).toBeInstanceOf(Date);
  });

  it("never clears a hash, and never touches consent", async () => {
    // The first keeps lib/admin-users.test.ts's invariant true (#52); the
    // second is because changing a password is not a new consent.
    await call(VALID);
    const data = userUpdate.mock.calls[0][0].data;
    expect(data.passwordHash).not.toBeNull();
    expect(data).not.toHaveProperty("termsAcceptedAt");
    expect(data).not.toHaveProperty("termsVersion");
  });

  it("kills any outstanding reset links", async () => {
    // Someone who changes their password deliberately has answered whatever
    // prompted an earlier "I forgot" — leaving that mail live would leave a
    // second key to the account sitting in an inbox.
    await call(VALID);
    expect(revokeTokensMock).toHaveBeenCalledWith("u1", "PASSWORD_RESET");
  });

  it("does not kill them when the change is refused", async () => {
    compareMock.mockResolvedValue(false);
    await call(VALID);
    expect(revokeTokensMock).not.toHaveBeenCalled();
  });

  it("still reports success when revoking the reset link fails", async () => {
    // The password write already happened and the caller's own session is
    // already dead from the stamp it wrote; a 500 here would say otherwise.
    revokeTokensMock.mockRejectedValue(new Error("db down"));
    const res = await call(VALID);
    expect(res.status).toBe(200);
    expect(userUpdate).toHaveBeenCalledTimes(1);
  });
});
