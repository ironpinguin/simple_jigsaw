import { beforeEach, describe, expect, it, vi } from "vitest";

const { consumeTokenMock, userUpdate, hashMock } = vi.hoisted(() => ({
  consumeTokenMock: vi.fn(),
  userUpdate: vi.fn(),
  hashMock: vi.fn(),
}));

vi.mock("@/lib/tokens", () => ({ consumeToken: consumeTokenMock }));
vi.mock("@/lib/db", () => ({ prisma: { user: { update: userUpdate } } }));
vi.mock("bcryptjs", () => ({ default: { hash: hashMock } }));
vi.mock("@/lib/i18n-server", () => ({ getErrorT: async () => (key: string) => key }));

import { POST } from "./route";

function call(body: unknown) {
  return POST(
    new Request("http://test/api/account/password/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const VALID = { token: "tok-123", password: "brandnewpass" };

describe("POST /api/account/password/reset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    consumeTokenMock.mockResolvedValue({ ok: true, userId: "u1" });
    hashMock.mockResolvedValue("$2b$new");
    userUpdate.mockResolvedValue({});
  });

  it("sets the new password when the link is good", async () => {
    const res = await call(VALID);
    expect(res.status).toBe(200);
    expect(consumeTokenMock).toHaveBeenCalledWith("tok-123", "PASSWORD_RESET");
  });

  it("writes the hash, the stamp and the verification in one update", async () => {
    // The stamp is what ends every other session; the verification is because
    // clicking a link sent to the address proves the same thing the
    // confirmation mail asks.
    await call(VALID);
    const data = userUpdate.mock.calls[0][0].data;

    expect(data.passwordHash).toBe("$2b$new");
    expect(data.passwordChangedAt).toBeInstanceOf(Date);
    expect(data.emailVerified).toBeInstanceOf(Date);
    expect(userUpdate).toHaveBeenCalledTimes(1);
  });

  it("never clears a hash, and never touches consent", async () => {
    await call(VALID);
    const data = userUpdate.mock.calls[0][0].data;
    expect(data.passwordHash).not.toBeNull();
    expect(data).not.toHaveProperty("termsAcceptedAt");
    expect(data).not.toHaveProperty("termsVersion");
  });

  it("refuses an expired, foreign or already-used link", async () => {
    consumeTokenMock.mockResolvedValue({ ok: false, reason: "invalid" });
    const res = await call(VALID);
    expect(res.status).toBe(400);
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("says so plainly when the token store itself is unavailable", async () => {
    // consumeToken distinguishes "no such link" from "could not check" so the
    // user is not told their valid link is invalid.
    consumeTokenMock.mockResolvedValue({ ok: false, reason: "unavailable" });
    const res = await call(VALID);
    expect(res.status).toBe(503);
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("refuses a password under the minimum without spending the link", async () => {
    const res = await call({ token: "tok-123", password: "short" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "passwordMin" });
    expect(consumeTokenMock).not.toHaveBeenCalled();
  });
});
