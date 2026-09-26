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

import {
  consumeToken,
  createToken,
  recordClaimFailure,
  revokeTokens,
  tokenClaimStatus,
  type TokenDb,
} from "./tokens";
import { tokenExpiry } from "./token-ttl";
import { prisma } from "./db";

const NOW = Date.UTC(2026, 7, 9, 12, 0, 0);

/**
 * The claim counters live on globalThis, for the reason lib/tokens.ts gives.
 * Cleared field by field rather than by deleting the global the way
 * lib/retention.test.ts does: the static import above already captured the
 * object, so deleting the key would only orphan it and leave every call in this
 * file mutating a counter `tokenClaimStatus` no longer reads.
 */
function resetClaimState() {
  const claims = (globalThis.__jigsawTokenClaims ??= { failures: 0, lost: 0, unattempted: 0 });
  claims.failures = 0;
  claims.lost = 0;
  claims.unattempted = 0;
  delete claims.lastFailureAt;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  create.mockResolvedValue({});
  // One row removed = this call is the one that claimed the token.
  deleteMany.mockResolvedValue({ count: 1 });
  maybePurge.mockResolvedValue(null);
  resetClaimState();
});

afterEach(() => {
  vi.useRealTimers();
  // restore, not just clear: the console.error spies below are restored inline,
  // and an assertion that throws before that line would otherwise leave stdout
  // stubbed for every test after it in this file.
  vi.restoreAllMocks();
  vi.clearAllMocks();
  resetClaimState();
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

describe("revokeTokens", () => {
  it("deletes only that user's tokens of that kind, and reports how many", async () => {
    // Scoped both ways on purpose, and neither guarantee is visible any other
    // way: without `type` a caller superseding one kind of link would silently
    // take out the user's other kinds too, and without `userId` it would take out
    // every user's. The count is what tells a caller how many live links it just
    // destroyed.
    deleteMany.mockResolvedValue({ count: 2 });

    await expect(revokeTokens("user-1", "INVITE")).resolves.toBe(2);
    expect(deleteMany).toHaveBeenCalledWith({ where: { userId: "user-1", type: "INVITE" } });
  });

  it("lets a failure through to the caller", async () => {
    // Unlike a claim, this one has somebody to report to: the admin route turns
    // it into a translated error rather than sending a second live link.
    deleteMany.mockRejectedValue(new Error("permission denied for table"));

    await expect(revokeTokens("user-1", "INVITE")).rejects.toThrow("permission denied");
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

    await expect(consumeToken("abc", "EMAIL_VERIFY", prisma)).resolves.toEqual({
      ok: true,
      userId: "user-1",
    });
    expect(deleteMany).toHaveBeenCalledWith({ where: { token: "abc", type: "EMAIL_VERIFY" } });
  });

  it("claims through the client it is given rather than the module's own", async () => {
    // What lets a route put the claim inside a transaction (#50): the delete has
    // to run on the transaction's connection, or the rollback that hands a
    // failed activation its link back would have nothing to undo.
    const txFindUnique = vi.fn().mockResolvedValue(row);
    const txDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
    // Cast because TokenDb is the real delegate type, not a structural stand-in:
    // keeping it exact is what stops a route handing `consumeToken` something
    // that is not the transaction's client. A double only needs the two calls.
    const tx = {
      verificationToken: { findUnique: txFindUnique, deleteMany: txDeleteMany },
    } as unknown as TokenDb;

    await expect(consumeToken("abc", "EMAIL_VERIFY", tx)).resolves.toEqual({
      ok: true,
      userId: "user-1",
    });

    expect(txDeleteMany).toHaveBeenCalledWith({ where: { token: "abc", type: "EMAIL_VERIFY" } });
    // Not the module-level client: a claim that deleted on a second connection
    // would commit on its own and survive the transaction rolling back.
    expect(findUnique).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("claims an INVITE by its own type", async () => {
    // The type the whole fix is about — an invite sets a password — and the one
    // with no happy path of its own until now. Both the guard above and the
    // delete's `where` mention `type`, and a hardcoded "EMAIL_VERIFY" in either
    // satisfies every other test in this file while killing invite redemption
    // outright on a real database: nothing matches, so nothing is ever claimed.
    findUnique.mockResolvedValue({ ...row, type: "INVITE" });

    await expect(consumeToken("abc", "INVITE", prisma)).resolves.toEqual({ ok: true, userId: "user-1" });
    expect(deleteMany).toHaveBeenCalledWith({ where: { token: "abc", type: "INVITE" } });
  });

  it("removes an expired row and refuses it", async () => {
    // The redeem path is the other half of retention: an expired token that
    // does get clicked leaves nothing behind either.
    findUnique.mockResolvedValue({ ...row, expiresAt: new Date(NOW - 1) });

    await expect(consumeToken("abc", "EMAIL_VERIFY", prisma)).resolves.toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(deleteMany).toHaveBeenCalledWith({ where: { token: "abc", type: "EMAIL_VERIFY" } });
  });

  it("refuses a token issued for another purpose without deleting it", async () => {
    findUnique.mockResolvedValue({ ...row, type: "INVITE" });

    await expect(consumeToken("abc", "EMAIL_VERIFY", prisma)).resolves.toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("refuses the redemption whose delete removed nothing", async () => {
    // The loser of a race, and the reason the delete has to be the claim: both
    // redemptions read the row before either delete lands, so read-then-delete
    // granted both. For an INVITE that is two people setting the password on one
    // account, each believing they were the only one.
    //
    // What a mocked client can pin is this half — a count of 0 is refused. The
    // other half, that only one concurrent DELETE can report a non-zero count,
    // belongs to the database and rests on `token @unique` in
    // prisma/schema.prisma; no test in this file can observe it.
    findUnique.mockResolvedValue(row);
    deleteMany.mockResolvedValue({ count: 0 });

    await expect(consumeToken("abc", "EMAIL_VERIFY", prisma)).resolves.toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("does not call a lost race an error", async () => {
    // Losing the race is ordinary. Only a genuine failure deserves the log, or
    // an operator learns nothing from it — and the probe must not turn amber
    // because somebody double-clicked.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    findUnique.mockResolvedValue(row);
    deleteMany.mockResolvedValue({ count: 0 });

    await consumeToken("abc", "EMAIL_VERIFY", prisma);

    expect(logged).not.toHaveBeenCalled();
    expect(tokenClaimStatus()).toMatchObject({ lost: 1, failures: 0, degraded: false });
  });

  it("refuses the token as unavailable when the delete fails outright", async () => {
    // A role without delete rights, a lock timeout, SQLITE_BUSY. Granting here
    // is the security bug — it leaves a single-use link live for its whole TTL —
    // and `unavailable` is what lets the route answer 503 instead of telling the
    // holder their perfectly good link has expired.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    findUnique.mockResolvedValue(row);
    deleteMany.mockRejectedValue(new Error("permission denied for table"));

    await expect(consumeToken("abc", "EMAIL_VERIFY", prisma)).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("[tokens]"), expect.any(Error));
  });

  it("names the type and the user in the log, and never the token", async () => {
    // Which link type is broken and whose account is stuck are the two things an
    // operator needs; the token is a live credential precisely because the
    // delete failed, so it must not reach the log.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    findUnique.mockResolvedValue({ ...row, type: "INVITE" });
    deleteMany.mockRejectedValue(new Error("permission denied for table"));

    await consumeToken("abc", "INVITE", prisma);

    const [message] = logged.mock.calls[0];
    expect(message).toContain("INVITE");
    expect(message).toContain("user-1");
    expect(message).not.toContain("abc");
  });

  it("refuses an unknown token", async () => {
    findUnique.mockResolvedValue(null);

    await expect(consumeToken("nope", "EMAIL_VERIFY", prisma)).resolves.toEqual({
      ok: false,
      reason: "invalid",
    });
  });
});

describe("recordClaimFailure", () => {
  it("counts and logs a claim that never got to run", async () => {
    // A transaction that cannot start throws around `consumeToken`, not inside
    // it, so the claim records nothing for itself — and the readiness probe goes
    // on reporting a healthy redeem path while every activation fails (#50).
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    recordClaimFailure("INVITE", new Error("Unable to start a transaction"));

    expect(tokenClaimStatus()).toMatchObject({ unattempted: 1, lastFailureAt: NOW });
    // Named the same way a failed delete is, so one grep finds both.
    expect(String(error.mock.calls[0][0])).toContain("[tokens]");
    expect(String(error.mock.calls[0][0])).toContain("INVITE");
    error.mockRestore();
  });

  it("does not call one collision a broken redeem path", async () => {
    // The commonest cause is two people redeeming at once on the SQLite stack,
    // whose single connection one activation holds for its whole transaction.
    // Degrading on that would leave the probe red for days on a quiet instance
    // — activations are rare, and only a success clears it — which is how a
    // signal stops being read. The sweep next door tolerates three for the
    // same reason.
    vi.spyOn(console, "error").mockImplementation(() => {});

    recordClaimFailure("INVITE", new Error("write conflict"));
    recordClaimFailure("INVITE", new Error("write conflict"));

    expect(tokenClaimStatus().degraded).toBe(false);
  });

  it("degrades once they stop looking like a collision", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    for (let i = 0; i < 3; i += 1) recordClaimFailure("INVITE", new Error("timed out"));

    expect(tokenClaimStatus()).toMatchObject({ unattempted: 3, degraded: true });
  });

  it("still degrades immediately when a delete itself fails", async () => {
    // Unchanged, and the distinction is the point: a DELETE that was refused is
    // evidence the redeem path is broken for everyone, not that two clicks
    // collided.
    vi.spyOn(console, "error").mockImplementation(() => {});
    findUnique.mockResolvedValue({
      token: "abc",
      type: "EMAIL_VERIFY",
      userId: "user-1",
      expiresAt: new Date(NOW + 1000),
    });
    deleteMany.mockRejectedValue(new Error("permission denied"));

    await consumeToken("abc", "EMAIL_VERIFY", prisma);

    expect(tokenClaimStatus().degraded).toBe(true);
  });

  it("books a transaction that expired under the delete as unattempted, not failed", async () => {
    // P2028/P2034 raised by the delete itself: a slow or colliding transaction,
    // not a DELETE the database refused. As a failure it degraded the probe on
    // one; as unattempted it gets the three a collision is allowed.
    vi.spyOn(console, "error").mockImplementation(() => {});
    findUnique.mockResolvedValue({
      token: "abc",
      type: "EMAIL_VERIFY",
      userId: "user-1",
      expiresAt: new Date(NOW + 1000),
    });
    deleteMany.mockRejectedValue(Object.assign(new Error("transaction expired"), { code: "P2028" }));

    await expect(consumeToken("abc", "EMAIL_VERIFY", prisma)).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(tokenClaimStatus()).toMatchObject({ failures: 0, unattempted: 1, degraded: false });
  });

  it("is cleared by the next claim that actually removes a row", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    findUnique.mockResolvedValue({
      token: "abc",
      type: "EMAIL_VERIFY",
      userId: "user-1",
      expiresAt: new Date(NOW + 1000),
    });

    for (let i = 0; i < 3; i += 1) recordClaimFailure("EMAIL_VERIFY", new Error("timed out"));
    expect(tokenClaimStatus().degraded).toBe(true);

    await consumeToken("abc", "EMAIL_VERIFY", prisma);

    expect(tokenClaimStatus()).toMatchObject({ unattempted: 0, degraded: false });
  });
});

describe("tokenClaimStatus", () => {
  const row = {
    token: "abc",
    type: "EMAIL_VERIFY",
    userId: "user-1",
    expiresAt: new Date(NOW + 1000),
  };

  it("is healthy on a fresh process", async () => {
    expect(tokenClaimStatus()).toEqual({
      failures: 0,
      lastFailureAt: null,
      lost: 0,
      unattempted: 0,
      degraded: false,
    });
  });

  it("goes degraded on the first failed claim", async () => {
    // One is the threshold, where the sweep tolerates three: a claim only runs
    // because somebody clicked their link, so there is no second window and the
    // one that failed already cost them their activation.
    vi.spyOn(console, "error").mockImplementation(() => {});
    findUnique.mockResolvedValue(row);
    deleteMany.mockRejectedValue(new Error("permission denied for table"));

    await consumeToken("abc", "EMAIL_VERIFY", prisma);

    expect(tokenClaimStatus()).toMatchObject({
      failures: 1,
      lastFailureAt: NOW,
      degraded: true,
    });
  });

  it("clears only when a delete actually removes a row", async () => {
    // A read proves nothing about the DELETE — that is the whole reason this
    // exists alongside the probe's `SELECT 1` — so nothing short of a real claim
    // may reset it. A lost race must not either: the row being gone says somebody
    // else deleted it, not that this instance can.
    vi.spyOn(console, "error").mockImplementation(() => {});
    findUnique.mockResolvedValue(row);
    deleteMany.mockRejectedValue(new Error("permission denied for table"));
    await consumeToken("abc", "EMAIL_VERIFY", prisma);

    deleteMany.mockReset().mockResolvedValue({ count: 0 });
    await consumeToken("abc", "EMAIL_VERIFY", prisma);
    expect(tokenClaimStatus()).toMatchObject({ failures: 1, degraded: true });

    deleteMany.mockReset().mockResolvedValue({ count: 1 });
    await consumeToken("abc", "EMAIL_VERIFY", prisma);
    expect(tokenClaimStatus()).toMatchObject({ failures: 0, degraded: false });
  });

  it("counts consecutive failures", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    findUnique.mockResolvedValue(row);
    deleteMany.mockRejectedValue(new Error("permission denied for table"));

    await consumeToken("abc", "EMAIL_VERIFY", prisma);
    await consumeToken("abc", "EMAIL_VERIFY", prisma);
    await consumeToken("abc", "EMAIL_VERIFY", prisma);

    expect(tokenClaimStatus()).toMatchObject({ failures: 3, degraded: true });
  });
});
