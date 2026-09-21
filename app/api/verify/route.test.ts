import { beforeEach, describe, expect, it, vi } from "vitest";

const { userUpdate, consumeTokenMock, transaction, tx, txState } = vi.hoisted(() => {
  const userUpdate = vi.fn();
  const tx = { user: { update: userUpdate } };
  // Prisma's own rollback cannot be exercised against a mock, so the double
  // records the one thing that stands in for it: whether the callback came back
  // or threw. A thrown callback is exactly what makes Prisma roll the claim
  // back, so "rolledBack" here means "the real client would have undone it".
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
  return { userUpdate, consumeTokenMock: vi.fn(), transaction, tx, txState };
});

vi.mock("@/lib/db", () => ({
  prisma: { user: { update: userUpdate }, $transaction: transaction },
}));
vi.mock("@/lib/tokens", () => ({ consumeToken: consumeTokenMock }));
// The key rather than the translation: these assertions are about which message
// the route picks, and pinning the German copy would break on any rewording.
vi.mock("@/lib/i18n-server", () => ({ getErrorT: async () => (key: string) => key }));

import { POST } from "./route";

function callPost(body: unknown) {
  return POST(
    new Request("http://test/api/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  txState.committed = 0;
  txState.rolledBack = 0;
  consumeTokenMock.mockResolvedValue({ ok: true, userId: "user-1" });
  userUpdate.mockResolvedValue({});
});

describe("POST /api/verify", () => {
  it("confirms the address when the token is claimed", async () => {
    const res = await callPost({ token: "tok" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(consumeTokenMock).toHaveBeenCalledWith("tok", "EMAIL_VERIFY", tx);
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { emailVerified: expect.any(Date) },
    });
  });

  it("refuses an invalid link with a 400 and confirms nothing", async () => {
    consumeTokenMock.mockResolvedValue({ ok: false, reason: "invalid" });

    const res = await callPost({ token: "tok" });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "verifyInvalid" });
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("answers 503 when the claim could not be attempted", async () => {
    // The half `consumeToken` cannot enforce on its own. A delete that failed
    // leaves the row — and the link — intact, so this is not the user's link
    // being bad: 503 says retry, keeps the 5xx an operator's monitoring watches,
    // and does not send the holder off to re-register.
    consumeTokenMock.mockResolvedValue({ ok: false, reason: "unavailable" });

    const res = await callPost({ token: "tok" });

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "linkUnavailable" });
  });

  it("confirms nobody when the claim could not be attempted", async () => {
    // The security property, stated on its own so it cannot be lost in a
    // refactor of the status codes above: an unspent token confirms no address.
    consumeTokenMock.mockResolvedValue({ ok: false, reason: "unavailable" });

    await callPost({ token: "tok" });

    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("rejects a body with no token before touching the database", async () => {
    const res = await callPost({});

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "invalidRequest" });
    expect(consumeTokenMock).not.toHaveBeenCalled();
  });

  it("rejects a body that is not JSON", async () => {
    const res = await POST(
      new Request("http://test/api/verify", { method: "POST", body: "not json" }),
    );

    expect(res.status).toBe(400);
    expect(consumeTokenMock).not.toHaveBeenCalled();
  });

  it("leaves the link claimable when the confirming write fails", async () => {
    // #50: the claim used to be irreversible and to land before the work it
    // authorises, so a write that threw here left the address unconfirmed with
    // the token already gone — and EMAIL_VERIFY is only minted at registration,
    // which a second attempt answers 409. Nothing brought the link back.
    userUpdate.mockRejectedValue(new Error("SQLITE_BUSY"));

    await expect(callPost({ token: "tok" })).rejects.toThrow("SQLITE_BUSY");

    expect(txState.rolledBack).toBe(1);
    expect(txState.committed).toBe(0);
  });

  it("claims the token on the transaction's own client", async () => {
    // The claim has to run on the connection the rollback governs; on any other
    // one the delete commits by itself and the link is gone regardless.
    await callPost({ token: "tok" });

    expect(consumeTokenMock).toHaveBeenCalledWith("tok", "EMAIL_VERIFY", tx);
    expect(txState.committed).toBe(1);
  });
});
