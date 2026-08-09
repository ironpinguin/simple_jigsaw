import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { create, deleteMany, findUnique, deleteOne } = vi.hoisted(() => ({
  create: vi.fn(),
  deleteMany: vi.fn(),
  findUnique: vi.fn(),
  deleteOne: vi.fn(),
}));

vi.mock("./db", () => ({
  prisma: {
    verificationToken: { create, deleteMany, delete: deleteOne, findUnique },
  },
}));

import { consumeToken, createToken, purgeExpiredTokens } from "./tokens";
import { expiredTokenFilter, tokenExpiry } from "./token-ttl";

const NOW = Date.UTC(2026, 7, 9, 12, 0, 0);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  create.mockResolvedValue({});
  deleteMany.mockResolvedValue({ count: 0 });
  deleteOne.mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("purgeExpiredTokens", () => {
  it("deletes the expired rows and reports how many", async () => {
    deleteMany.mockResolvedValue({ count: 7 });

    await expect(purgeExpiredTokens(NOW)).resolves.toBe(7);
    expect(deleteMany).toHaveBeenCalledWith({ where: expiredTokenFilter(NOW) });
  });
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

  it("purges expired rows when it issues a token", async () => {
    // Without an operator running `npm run purge-expired`, issuing a token is
    // the only thing that ever cleans the table.
    await createToken("user-1", "EMAIL_VERIFY");

    expect(deleteMany).toHaveBeenCalledWith({ where: expiredTokenFilter(NOW) });
  });

  it("still issues the token when the purge fails, and says so", async () => {
    // Retention housekeeping must not turn a registration or an invite into a
    // 500 — the user cannot act on it and has no other way in. It must not be
    // silent either: this is the sweep the privacy policy promises, and a
    // permanently failing one is otherwise indistinguishable from a table that
    // had nothing to clean.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    deleteMany.mockRejectedValue(new Error("db is having a day"));

    await expect(createToken("user-1", "EMAIL_VERIFY")).resolves.toMatch(/^[0-9a-f]{64}$/);
    expect(create).toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining("purge of expired tokens failed"),
      expect.any(Error),
    );
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
    expect(deleteOne).toHaveBeenCalledWith({ where: { token: "abc" } });
  });

  it("removes an expired row and refuses it", async () => {
    // The redeem path is the other half of retention: an expired token that
    // does get clicked leaves nothing behind either.
    findUnique.mockResolvedValue({ ...row, expiresAt: new Date(NOW - 1) });

    await expect(consumeToken("abc", "EMAIL_VERIFY")).resolves.toBeNull();
    expect(deleteOne).toHaveBeenCalledWith({ where: { token: "abc" } });
  });

  it("refuses a token issued for another purpose without deleting it", async () => {
    findUnique.mockResolvedValue({ ...row, type: "INVITE" });

    await expect(consumeToken("abc", "EMAIL_VERIFY")).resolves.toBeNull();
    expect(deleteOne).not.toHaveBeenCalled();
  });

  it("refuses an unknown token", async () => {
    findUnique.mockResolvedValue(null);

    await expect(consumeToken("nope", "EMAIL_VERIFY")).resolves.toBeNull();
  });
});
