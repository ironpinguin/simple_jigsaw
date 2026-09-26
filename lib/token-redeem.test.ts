import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { consumeTokenMock, recordClaimFailureMock, transaction, tx, txState } = vi.hoisted(() => {
  const tx = { user: { update: vi.fn() } };
  // Prisma's rollback cannot be exercised against a mock, so the double records
  // what stands in for it: whether the callback came back or threw.
  const txState = { committed: 0, rolledBack: 0 };
  const transaction = vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => {
    try {
      const result = await fn(tx);
      txState.committed += 1;
      return result;
    } catch (error) {
      txState.rolledBack += 1;
      throw error;
    }
  });
  return {
    consumeTokenMock: vi.fn(),
    recordClaimFailureMock: vi.fn(),
    transaction,
    tx,
    txState,
  };
});

vi.mock("./db", () => ({ prisma: { $transaction: transaction } }));
vi.mock("./tokens", () => ({
  consumeToken: consumeTokenMock,
  recordClaimFailure: recordClaimFailureMock,
}));

import { Refused, redeemToken } from "./token-redeem";

const transient = (code: "P2028" | "P2034") =>
  Object.assign(new Error(`transient ${code}`), { code });

beforeEach(() => {
  txState.committed = 0;
  txState.rolledBack = 0;
  consumeTokenMock.mockResolvedValue({ ok: true, userId: "user-1" });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("redeemToken", () => {
  it("claims on the transaction's client and hands the work that client and the user", async () => {
    // The claim and the work have to share the connection the rollback governs;
    // on any other one the delete commits by itself and the link is gone.
    const work = vi.fn().mockResolvedValue("done");

    await expect(redeemToken("tok", "INVITE", work)).resolves.toEqual({
      ok: true,
      userId: "user-1",
      value: "done",
    });
    expect(consumeTokenMock).toHaveBeenCalledWith("tok", "INVITE", tx);
    expect(work).toHaveBeenCalledWith(tx, "user-1");
    expect(txState.committed).toBe(1);
  });

  it("passes a refused claim on and never runs the work", async () => {
    consumeTokenMock.mockResolvedValue({ ok: false, reason: "invalid" });
    const work = vi.fn();

    await expect(redeemToken("tok", "INVITE", work)).resolves.toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(work).not.toHaveBeenCalled();
    // Rolled back, so an expired row's delete is undone with the refusal.
    expect(txState.rolledBack).toBe(1);
  });

  it("does not book a refused claim a second time", async () => {
    // consumeToken counts its own refusals; counting here too would degrade the
    // probe twice as fast.
    consumeTokenMock.mockResolvedValue({ ok: false, reason: "unavailable" });

    await expect(redeemToken("tok", "INVITE", vi.fn())).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(recordClaimFailureMock).not.toHaveBeenCalled();
  });

  it("rolls the claim back with a refusal from the work, and reports it with its user", async () => {
    const result = await redeemToken<void, "emailBanned">("tok", "INVITE", async (_tx, userId) => {
      throw new Refused("emailBanned", userId);
    });

    expect(result).toEqual({ ok: false, reason: "emailBanned", userId: "user-1" });
    expect(txState.rolledBack).toBe(1);
    expect(txState.committed).toBe(0);
  });

  it("books a transaction that failed before the claim ran", async () => {
    // P2028 comes out of `$transaction`, not out of the claim, so the claim
    // records nothing for itself (#50).
    const error = transient("P2028");
    transaction.mockRejectedValueOnce(error);

    await expect(redeemToken("tok", "EMAIL_VERIFY", vi.fn())).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(recordClaimFailureMock).toHaveBeenCalledWith("EMAIL_VERIFY", error);
  });

  it("does not book a collision after a successful claim, and logs whose it was", async () => {
    // A P2034 from the work's own write: the DELETE worked, so it says nothing
    // about the redeem path. Booking it after consumeToken had just cleared the
    // counters turned write conflicts on a user row into a degraded probe.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await redeemToken("live-secret-link", "PASSWORD_RESET", async () => {
      throw transient("P2034");
    });

    expect(result).toEqual({ ok: false, reason: "unavailable", userId: "user-1" });
    expect(recordClaimFailureMock).not.toHaveBeenCalled();
    expect(txState.rolledBack).toBe(1);
    const [message] = logged.mock.calls[0];
    expect(message).toContain("[tokens]");
    expect(message).toContain("PASSWORD_RESET");
    expect(message).toContain("user-1");
    // Never the token: the rollback just made it a live credential again.
    expect(message).not.toContain("live-secret-link");
  });

  it("answers a refused claim with its own verdict when the transaction then fails", async () => {
    // The claim refused and booked itself; a transient error on the way out
    // must neither be booked again nor turn an invalid link into a retry.
    consumeTokenMock.mockResolvedValue({ ok: false, reason: "invalid" });
    transaction.mockImplementationOnce(async (fn) => {
      await fn(tx).catch(() => {});
      throw transient("P2028");
    });

    await expect(redeemToken("tok", "INVITE", vi.fn())).resolves.toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(recordClaimFailureMock).not.toHaveBeenCalled();
  });

  it("rethrows anything else untouched, after rolling back", async () => {
    // A failed write or a bug is the caller's to answer; hiding it behind
    // "try again" would be wrong, and the link survives it either way.
    const boom = new Error("SQLITE_BUSY");

    await expect(
      redeemToken("tok", "EMAIL_VERIFY", async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(txState.rolledBack).toBe(1);
    expect(recordClaimFailureMock).not.toHaveBeenCalled();
  });
});
