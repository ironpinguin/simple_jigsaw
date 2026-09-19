import { beforeEach, describe, expect, it, vi } from "vitest";

const { consumeTokenMock, revokeTokensMock, userUpdate, hashMock } = vi.hoisted(() => ({
  consumeTokenMock: vi.fn(),
  revokeTokensMock: vi.fn(),
  userUpdate: vi.fn(),
  hashMock: vi.fn(),
}));

vi.mock("@/lib/tokens", () => ({ consumeToken: consumeTokenMock, revokeTokens: revokeTokensMock }));
vi.mock("@/lib/db", () => ({ prisma: { user: { update: userUpdate } } }));
vi.mock("bcryptjs", () => ({ default: { hash: hashMock } }));
vi.mock("@/lib/i18n-server", () => ({ getErrorT: async () => (key: string) => key }));

import { POST } from "./route";
import { isSessionStale } from "@/lib/session-freshness";

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
    revokeTokensMock.mockResolvedValue(0);
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

  it("stamps passwordChangedAt after the hash, not before it", async () => {
    // Read before the bcrypt round, the stamp is dated a whole hash early —
    // 60-150 ms out of the 1000 ms SESSION_CUTOFF_MARGIN_MS has to cover the
    // stamp, the write and the re-issue together. Fake timers stand in for the
    // round: the stamp must carry the time hashing finished, not when it began.
    vi.useFakeTimers();
    try {
      const startedAt = Date.now();
      hashMock.mockImplementation(async () => {
        vi.advanceTimersByTime(150);
        return "$2b$new";
      });

      await call(VALID);
      const data = userUpdate.mock.calls[0][0].data;

      expect(data.passwordChangedAt.getTime()).toBe(startedAt + 150);
      expect(data.emailVerified.getTime()).toBe(startedAt + 150);
    } finally {
      vi.useRealTimers();
    }
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
    expect(await res.json()).toEqual({ error: "resetInvalid" });
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

  it("reports a passphrase over bcrypt's byte limit as too long, not too short", async () => {
    // The limit is bcrypt's 72 bytes, so it is counted in bytes: 20 four-byte
    // emoji are 80. Reporting this as passwordMin would tell the user to
    // lengthen a password that is already too long.
    const res = await call({ token: "tok-123", password: "🧩".repeat(20) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "passwordMax" });
    expect(consumeTokenMock).not.toHaveBeenCalled();
  });

  it("calls a password of the wrong type malformed rather than too short", async () => {
    // A non-string password is a broken client, not a length the user chose;
    // "at least 8 characters" describes a rule it never broke.
    const res = await call({ token: "tok-123", password: 12345678 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalidRequest" });
    expect(consumeTokenMock).not.toHaveBeenCalled();
  });

  it("revokes the account's other outstanding reset links after a successful reset", async () => {
    // Up to two more PASSWORD_RESET links can still be live (RESET_PER_EMAIL_LIMIT
    // is 3); completing one answers the same question the others were sent for.
    await call(VALID);
    expect(revokeTokensMock).toHaveBeenCalledWith("u1", "PASSWORD_RESET");
    expect(userUpdate).toHaveBeenCalledTimes(1);
  });

  it("does not revoke anything when the link itself is invalid", async () => {
    consumeTokenMock.mockResolvedValue({ ok: false, reason: "invalid" });
    await call(VALID);
    expect(revokeTokensMock).not.toHaveBeenCalled();
  });

  it("still reports success when revoking the other reset links fails", async () => {
    // The password write already happened by then, so a 500 here would tell
    // the user the opposite of what actually happened.
    revokeTokensMock.mockRejectedValue(new Error("db down"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call(VALID);
    expect(res.status).toBe(200);
    expect(userUpdate).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalled();
  });

  it("says the link is spent rather than expired when the password write fails", async () => {
    // consumeToken has already deleted the row by then. An uncaught throw here
    // would be a 500, which the page renders as "the link may have expired" —
    // the one explanation that is certainly wrong, since a valid link was just
    // spent. Nothing must be revoked either: the password did not change.
    userUpdate.mockRejectedValue(new Error("db down"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call(VALID);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "resetNotApplied" });
    expect(revokeTokensMock).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalled();
  });

  it("writes a passwordChangedAt that makes a session issued before the reset stale, and one issued after fresh", async () => {
    // The spec asks for "a session issued before a reset is refused
    // afterwards" — the earlier test above only checks the stamp's type, not
    // that composing it with isSessionStale actually invalidates a session.
    await call(VALID);
    const changedAt: Date = userUpdate.mock.calls[0][0].data.passwordChangedAt;
    const changedAtSeconds = Math.floor(changedAt.getTime() / 1000);

    expect(isSessionStale(changedAtSeconds - 10, changedAt)).toBe(true);
    expect(isSessionStale(changedAtSeconds + 10, changedAt)).toBe(false);
  });
});
