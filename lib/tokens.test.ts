import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { create, findUnique, deleteMany, maybePurge } = vi.hoisted(() => ({
  create: vi.fn(),
  findUnique: vi.fn(),
  deleteMany: vi.fn(),
  maybePurge: vi.fn(),
}));

vi.mock("./db", () => ({
  prisma: {
    verificationToken: { create, deleteMany, findUnique },
  },
}));
vi.mock("./retention", () => ({ maybePurgeExpiredTokens: maybePurge }));

import { consumeToken, createToken } from "./tokens";
import { tokenExpiry } from "./token-ttl";

const NOW = Date.UTC(2026, 7, 9, 12, 0, 0);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  create.mockResolvedValue({});
  // One row removed = this call is the one that claimed the token.
  deleteMany.mockResolvedValue({ count: 1 });
  maybePurge.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("createToken", () => {
  it("stores a random token with the type's expiry", async () => {
    await createToken("user-1", "INVITE");

    const { data } = create.mock.calls[0][0];
    expect(data).toMatchObject({ type: "INVITE", userId: "user-1" });
    expect(data.expiresAt).toEqual(tokenExpiry("INVITE", NOW));
    expect(data.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns a different token every time", async () => {
    const first = await createToken("user-1", "EMAIL_VERIFY");
    const second = await createToken("user-1", "EMAIL_VERIFY");

    expect(first).not.toEqual(second);
  });

  it("asks for a sweep when it issues a token", async () => {
    // Without the timer or a probe — a bare `docker run` — issuing a token is
    // the only thing that cleans the table. The throttle decides whether the
    // sweep actually runs; this only pins that the ask happens.
    await createToken("user-1", "EMAIL_VERIFY");

    expect(maybePurge).toHaveBeenCalledWith(NOW);
  });
});

describe("consumeToken", () => {
  const row = {
    token: "abc",
    type: "EMAIL_VERIFY",
    userId: "user-1",
    expiresAt: new Date(NOW + 1000),
  };

  it("returns the user and removes the row", async () => {
    findUnique.mockResolvedValue(row);

    await expect(consumeToken("abc", "EMAIL_VERIFY")).resolves.toEqual({ userId: "user-1" });
    expect(deleteMany).toHaveBeenCalledWith({ where: { token: "abc", type: "EMAIL_VERIFY" } });
  });

  it("removes an expired row and refuses it", async () => {
    // The redeem path is the other half of retention: an expired token that
    // does get clicked leaves nothing behind either.
    findUnique.mockResolvedValue({ ...row, expiresAt: new Date(NOW - 1) });

    await expect(consumeToken("abc", "EMAIL_VERIFY")).resolves.toBeNull();
    expect(deleteMany).toHaveBeenCalledWith({ where: { token: "abc", type: "EMAIL_VERIFY" } });
  });

  it("refuses a token issued for another purpose without deleting it", async () => {
    findUnique.mockResolvedValue({ ...row, type: "INVITE" });

    await expect(consumeToken("abc", "EMAIL_VERIFY")).resolves.toBeNull();
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("lets exactly one of two concurrent redemptions win", async () => {
    // The property the old code silently lacked. Both calls read the row before
    // either deletes, so read-then-delete is not a claim: the loser's delete
    // threw P2025 into an empty catch and it returned a userId anyway. For an
    // INVITE — a password-setting link — that means two people setting the
    // password on one account, each believing they were the only one.
    findUnique.mockResolvedValue(row);
    deleteMany
      .mockResolvedValueOnce({ count: 1 }) // winner: the row was there
      .mockResolvedValueOnce({ count: 0 }); // loser: already gone

    const results = await Promise.all([
      consumeToken("abc", "EMAIL_VERIFY"),
      consumeToken("abc", "EMAIL_VERIFY"),
    ]);

    expect(results.filter(Boolean)).toEqual([{ userId: "user-1" }]);
  });

  it("refuses a token whose row was already gone, without calling it an error", async () => {
    // Losing the race is ordinary. Only a genuine failure deserves the log, or
    // an operator learns nothing from it.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    findUnique.mockResolvedValue(row);
    deleteMany.mockResolvedValue({ count: 0 });

    await expect(consumeToken("abc", "EMAIL_VERIFY")).resolves.toBeNull();

    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it("refuses the token and says so when the delete fails outright", async () => {
    // A role without delete rights, a lock timeout, SQLITE_BUSY. The old code
    // swallowed all of them and returned the userId, leaving a single-use link
    // live for up to seven days with nothing in the log. Refusing is the safe
    // direction: the holder can ask for a new link, and the operator gets a
    // line naming the cause.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    findUnique.mockResolvedValue(row);
    deleteMany.mockRejectedValue(new Error("permission denied for table"));

    await expect(consumeToken("abc", "EMAIL_VERIFY")).resolves.toBeNull();

    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining("[tokens]"),
      expect.any(Error),
    );
    logged.mockRestore();
  });

  it("refuses an unknown token", async () => {
    findUnique.mockResolvedValue(null);

    await expect(consumeToken("nope", "EMAIL_VERIFY")).resolves.toBeNull();
  });
});
