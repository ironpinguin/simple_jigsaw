import { beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import { TERMS_VERSION } from "@/lib/legal";

const {
  userFindUnique,
  userUpdate,
  consumeTokenMock,
  checkEmailBannedMock,
  resolveRequestLocaleMock,
  resolveBrowserLocaleMock,
  transaction,
  tx,
  txState,
} = vi.hoisted(() => {
  const userFindUnique = vi.fn();
  const userUpdate = vi.fn();
  const tx = { user: { findUnique: userFindUnique, update: userUpdate } };
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
  return {
    userFindUnique,
    userUpdate,
    consumeTokenMock: vi.fn(),
    checkEmailBannedMock: vi.fn(),
    resolveRequestLocaleMock: vi.fn(),
    resolveBrowserLocaleMock: vi.fn(),
    transaction,
    tx,
    txState,
  };
});

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: userFindUnique, update: userUpdate },
    $transaction: transaction,
  },
}));
vi.mock("@/lib/tokens", () => ({ consumeToken: consumeTokenMock }));
vi.mock("@/lib/moderation", () => ({ checkEmailBanned: checkEmailBannedMock }));
// The key rather than the translation: these assertions are about which message
// the route picks, and pinning the German copy would break on any rewording.
// Deliberately not "de": that is the default locale and the fallback in both
// resolveRequestLocale and mail.ts's resolveLocale, so the locale assertion
// below would still pass if the route dropped it on the floor.
vi.mock("@/lib/i18n-server", () => ({
  getErrorT: async () => (key: string) => key,
  resolveRequestLocale: resolveRequestLocaleMock,
  resolveBrowserLocale: resolveBrowserLocaleMock,
}));

import { POST } from "./route";

const VALID = { token: "tok", password: "correct horse", termsAccepted: true };

function callPost(body: unknown) {
  return POST(
    new Request("http://test/api/invite", {
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
  userFindUnique.mockResolvedValue({ id: "user-1", email: "invited@example.com" });
  checkEmailBannedMock.mockResolvedValue(false);
  userUpdate.mockResolvedValue({});
  // The two differ on purpose: the cookie-preferring resolver would report the
  // locale of the admin's invite link, the header-only one the invitee's own.
  resolveRequestLocaleMock.mockResolvedValue("de");
  resolveBrowserLocaleMock.mockResolvedValue("it");
});

describe("POST /api/invite", () => {
  it("stores the invitee's own language, not the one their invite link carried", async () => {
    // Activation is the first moment the invitee's language is observable, and
    // the one chance to record it before anybody mails them unprompted. It must
    // not come from NEXT_LOCALE: an admin's /de link makes next-intl write that
    // cookie on the invitee's very first page view, so the cookie-preferring
    // resolver would pin the admin's language on them for good.
    await callPost(VALID);

    expect(userUpdate.mock.calls[0][0]).toMatchObject({ data: { locale: "it" } });
    expect(resolveRequestLocaleMock).not.toHaveBeenCalled();
  });

  it("sets the password and activates the account when the token is claimed", async () => {
    const res = await callPost(VALID);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(consumeTokenMock).toHaveBeenCalledWith("tok", "INVITE", tx);

    const { where, data } = userUpdate.mock.calls[0][0];
    expect(where).toEqual({ id: "user-1" });
    expect(data).toMatchObject({ termsVersion: TERMS_VERSION });
    expect(data.emailVerified).toBeInstanceOf(Date);
    expect(data.termsAcceptedAt).toBeInstanceOf(Date);
    // The hash, never the password itself.
    expect(data.passwordHash).not.toBe(VALID.password);
    await expect(bcrypt.compare(VALID.password, data.passwordHash)).resolves.toBe(true);
  });

  it("refuses an invalid link with a 400 and sets no password", async () => {
    consumeTokenMock.mockResolvedValue({ ok: false, reason: "invalid" });

    const res = await callPost(VALID);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "inviteInvalid" });
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("answers 503 when the claim could not be attempted", async () => {
    // A failed delete leaves the invite intact, so a retry may work — and this
    // is the route with no self-service resend, where wrongly calling the link
    // expired leaves an account only an admin can rescue.
    consumeTokenMock.mockResolvedValue({ ok: false, reason: "unavailable" });

    const res = await callPost(VALID);

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "linkUnavailable" });
  });

  it("sets no password when the claim could not be attempted", async () => {
    // This is what the whole fix is for, and until now it was asserted only in a
    // docstring. An invite is a password-setting link: if a token that was never
    // actually spent can still reach the update below, anyone holding a copy of
    // the mail can set the password again after the recipient has activated.
    consumeTokenMock.mockResolvedValue({ ok: false, reason: "unavailable" });

    await callPost(VALID);

    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("answers 404 when the invited account has gone", async () => {
    userFindUnique.mockResolvedValue(null);

    const res = await callPost(VALID);

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "accountNotFound" });
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("answers 403 and sets no password when the address has since been banned", async () => {
    checkEmailBannedMock.mockResolvedValue(true);

    const res = await callPost(VALID);

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "emailBanned" });
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("rejects a short password before claiming the token", async () => {
    // Claiming first would burn the invite on a typo, and there is no resend.
    const res = await callPost({ ...VALID, password: "short" });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "passwordMin" });
    expect(consumeTokenMock).not.toHaveBeenCalled();
  });

  it("rejects an activation that does not accept the terms", async () => {
    const res = await callPost({ ...VALID, termsAccepted: false });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "termsNotAccepted" });
    expect(consumeTokenMock).not.toHaveBeenCalled();
  });

  it("leaves the invitation claimable when the activating write fails", async () => {
    // The symptom #50 opens with: the claim is irreversible and lands before the
    // work it authorises, so a write that threw left the account unactivated
    // with the link already dead. INVITE is minted only by an admin and a second
    // registration answers 409, so nothing but an operator could rescue it.
    userUpdate.mockRejectedValue(new Error("SQLITE_BUSY"));

    await expect(callPost(VALID)).rejects.toThrow("SQLITE_BUSY");

    expect(txState.rolledBack).toBe(1);
    expect(txState.committed).toBe(0);
  });

  it("does not burn the invitation when the invited account has gone", async () => {
    userFindUnique.mockResolvedValue(null);

    await callPost(VALID);

    expect(txState.rolledBack).toBe(1);
    expect(txState.committed).toBe(0);
  });

  it("does not burn the invitation when the address has since been banned", async () => {
    // A ban is a moderation decision that can be reversed; the link dying with
    // it is not. Unbanning should leave the original invitation usable.
    checkEmailBannedMock.mockResolvedValue(true);

    await callPost(VALID);

    expect(txState.rolledBack).toBe(1);
    expect(txState.committed).toBe(0);
  });

  it("claims the invitation on the transaction's own client", async () => {
    // The claim has to run on the connection the rollback governs; on any other
    // one the delete commits by itself and the invitation is gone regardless.
    await callPost(VALID);

    expect(consumeTokenMock).toHaveBeenCalledWith("tok", "INVITE", tx);
    expect(checkEmailBannedMock).toHaveBeenCalledWith("invited@example.com", tx);
    expect(txState.committed).toBe(1);
  });

  it("hashes the password before opening the transaction", async () => {
    // bcrypt at cost 10 is ~100ms of CPU. Held inside the transaction it would
    // sit on a write lock for that long — on SQLite, blocking every other
    // writer — for work that needs no database at all.
    const hash = vi.spyOn(bcrypt, "hash");

    await callPost(VALID);

    expect(hash).toHaveBeenCalled();
    expect(hash.mock.invocationCallOrder[0]).toBeLessThan(transaction.mock.invocationCallOrder[0]);
  });

  it("never answers ok for a refusal it does not recognise", async () => {
    // The switch over the refusal reasons has no safe fallthrough: the success
    // response sits right after it, so a reason added to the union and not to
    // the switch would activate nobody and report success. An unknown refusal
    // has to fail loudly instead.
    consumeTokenMock.mockResolvedValue({ ok: false, reason: "something-new" });

    await expect(callPost(VALID)).rejects.toThrow();

    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("names the account in the log when the invited account has gone", async () => {
    // An operator answering "my invite does not work" gets a 404 in an access
    // log and nothing else unless the account is named here.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    userFindUnique.mockResolvedValue(null);

    await callPost(VALID);

    const logged = [...warn.mock.calls, ...error.mock.calls].map((args) => String(args[0]));
    expect(logged.some((line) => line.includes("user-1"))).toBe(true);
    warn.mockRestore();
    error.mockRestore();
  });

  it("names the account in the log when the address has since been banned", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    checkEmailBannedMock.mockResolvedValue(true);

    await callPost(VALID);

    const logged = [...warn.mock.calls, ...error.mock.calls].map((args) => String(args[0]));
    expect(logged.some((line) => line.includes("user-1"))).toBe(true);
    // Never the address itself: this line lands in an operator's log for an
    // account that may since have asked to be erased.
    expect(logged.some((line) => line.includes("invited@example.com"))).toBe(false);
    warn.mockRestore();
    error.mockRestore();
  });
});
