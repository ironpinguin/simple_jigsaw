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
    constructor(readonly key: string) {
      super(`storage delete of ${key} failed`);
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
    // Reporting success here would tell the user their image is gone while it
    // is still being served by app/api/image.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    deleteAccountMock.mockRejectedValue(new StorageCleanupError("puzzles/a.webp"));

    const res = await callDelete();

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual({ error: "storageFailed" });
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining("puzzles/a.webp"),
      undefined,
    );
  });

  it("answers 404 when the row is already gone", async () => {
    deleteAccountMock.mockResolvedValue(false);
    const res = await callDelete();
    expect(res.status).toBe(404);
  });

  it("does not swallow an unexpected failure as a storage error", async () => {
    // A bug in the deletion path must surface, not be reported as "retry, the
    // object store is down".
    deleteAccountMock.mockRejectedValue(new Error("boom"));
    await expect(callDelete()).rejects.toThrow("boom");
  });
});
