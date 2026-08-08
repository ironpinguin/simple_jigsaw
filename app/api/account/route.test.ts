import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getSessionUserMock,
  userFindUnique,
  userCount,
  deleteAccountMock,
  compareMock,
  StorageCleanupError,
} = vi.hoisted(() => {
  class StorageCleanupError extends Error {
    constructor(
      readonly key: string,
      readonly deleted: readonly string[] = [],
    ) {
      super(`storage delete of ${key} failed`);
      this.name = "StorageCleanupError";
    }
  }
  return {
    getSessionUserMock: vi.fn(),
    userFindUnique: vi.fn(),
    userCount: vi.fn(),
    deleteAccountMock: vi.fn(),
    compareMock: vi.fn(),
    StorageCleanupError,
  };
});

vi.mock("@/lib/auth", () => ({ getSessionUser: getSessionUserMock }));
vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: userFindUnique, count: userCount } },
}));
vi.mock("@/lib/account-deletion", () => ({
  deleteAccount: deleteAccountMock,
  StorageCleanupError,
}));
vi.mock("bcryptjs", () => ({ default: { compare: compareMock } }));
vi.mock("@/lib/i18n-server", () => ({ getErrorT: async () => (key: string) => key }));

import { DELETE } from "./route";

function callDelete(body: unknown = { password: "secret123" }) {
  return DELETE(
    new Request("http://test/api/account", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getSessionUserMock.mockResolvedValue({ id: "u1", email: "u@example.com", role: "USER" });
  userFindUnique.mockResolvedValue({ id: "u1", role: "USER", passwordHash: "hash" });
  userCount.mockResolvedValue(2);
  compareMock.mockResolvedValue(true);
  deleteAccountMock.mockResolvedValue(true);
});

describe("DELETE /api/account", () => {
  it("answers 401 without a session", async () => {
    getSessionUserMock.mockResolvedValue(null);
    const res = await callDelete();
    expect(res.status).toBe(401);
    expect(deleteAccountMock).not.toHaveBeenCalled();
  });

  it("rejects a body without a password", async () => {
    const res = await callDelete({});
    expect(res.status).toBe(400);
    expect(deleteAccountMock).not.toHaveBeenCalled();
  });

  it("rejects a wrong password", async () => {
    // The session cookie alone must not be enough to erase an account.
    compareMock.mockResolvedValue(false);
    const res = await callDelete();
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "wrongPassword" });
    expect(deleteAccountMock).not.toHaveBeenCalled();
  });

  it("deletes the account behind the session, not one named by the caller", async () => {
    // The id comes from the session; a body field must not be able to steer it.
    await callDelete({ password: "secret123", id: "someone-else" });
    expect(deleteAccountMock).toHaveBeenCalledWith("u1");
  });

  it("deletes the account on the right password", async () => {
    const res = await callDelete();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("refuses to remove the last admin", async () => {
    userFindUnique.mockResolvedValue({ id: "u1", role: "ADMIN", passwordHash: "hash" });
    userCount.mockResolvedValue(1);
    const res = await callDelete();
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "lastAdminDelete" });
    expect(deleteAccountMock).not.toHaveBeenCalled();
  });

  it("lets an admin go while another one remains", async () => {
    userFindUnique.mockResolvedValue({ id: "u1", role: "ADMIN", passwordHash: "hash" });
    userCount.mockResolvedValue(2);
    const res = await callDelete();
    expect(res.status).toBe(200);
  });

  it("answers 502 when an image could not be deleted", async () => {
    // The rows are all still there, so the images they point at are still
    // being served — reporting success would claim an erasure that did not
    // happen.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = new StorageCleanupError("puzzles/b.webp", ["puzzles/a.webp"]);
    deleteAccountMock.mockRejectedValue(err);

    const res = await callDelete();

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual({ error: "storageFailed" });
    // The log has to carry the error itself — logging only err.cause drops the
    // stack when deleteObject rejects with a non-Error.
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("puzzles/b.webp"), err);
  });

  it("logs how many objects were already gone when the run stopped", async () => {
    // Without the count, a puzzle left pointing at a deleted object has
    // nothing tying it back to this attempt.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    deleteAccountMock.mockRejectedValue(
      new StorageCleanupError("puzzles/c.webp", ["puzzles/a.webp", "puzzles/b.webp"]),
    );

    await callDelete();

    expect(logged.mock.calls[0][0]).toContain("2 object(s)");
  });

  it("rejects an account that has no password hash without calling bcrypt", async () => {
    // Such a row cannot hold a session today, but the guard is what keeps
    // bcrypt.compare from throwing on a null hash if one ever does.
    userFindUnique.mockResolvedValue({ id: "u1", role: "USER", passwordHash: null });

    const res = await callDelete();

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "wrongPassword" });
    expect(compareMock).not.toHaveBeenCalled();
    expect(deleteAccountMock).not.toHaveBeenCalled();
  });

  it("answers 404 when the session outlives its row", async () => {
    // A JWT stays valid after an admin deletes the user; nothing may be
    // deleted on its behalf.
    userFindUnique.mockResolvedValue(null);

    const res = await callDelete();

    expect(res.status).toBe(404);
    expect(compareMock).not.toHaveBeenCalled();
    expect(deleteAccountMock).not.toHaveBeenCalled();
  });

  it("answers 404 when the row is already gone", async () => {
    deleteAccountMock.mockResolvedValue(false);
    const res = await callDelete();
    expect(res.status).toBe(404);
  });

  it("does not swallow an unexpected failure as a storage error", async () => {
    // A bug in the deletion path must surface, not be reported as "retry, the
    // object store is down".
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    deleteAccountMock.mockRejectedValue(new Error("boom"));

    await expect(callDelete()).rejects.toThrow("boom");

    // Rethrowing is right; rethrowing silently is not — every image is gone
    // by the time the transaction runs, so this is not "nothing happened".
    expect(logged).toHaveBeenCalled();
  });
});
