import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { create, findUnique, deleteOne, maybePurge } = vi.hoisted(() => ({
  create: vi.fn(),
  findUnique: vi.fn(),
  deleteOne: vi.fn(),
  maybePurge: vi.fn(),
}));

vi.mock("./db", () => ({
  prisma: {
    verificationToken: { create, delete: deleteOne, findUnique },
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
  deleteOne.mockResolvedValue({});
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
