import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireAdminMock, userFindUnique, userCount, userUpdate, deleteAccountMock, StorageCleanupError } =
  vi.hoisted(() => {
    class StorageCleanupError extends Error {
      constructor(readonly key: string) {
        super(`storage delete of ${key} failed`);
      }
    }
    return {
      requireAdminMock: vi.fn(),
      userFindUnique: vi.fn(),
      userCount: vi.fn(),
      userUpdate: vi.fn(),
      deleteAccountMock: vi.fn(),
      StorageCleanupError,
    };
  });

vi.mock("@/lib/auth", () => ({ requireAdmin: requireAdminMock }));
vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: userFindUnique, count: userCount, update: userUpdate } },
}));
vi.mock("@/lib/account-deletion", () => ({
  deleteAccount: deleteAccountMock,
  StorageCleanupError,
}));
vi.mock("@/lib/i18n-server", () => ({ getErrorT: async () => (key: string) => key }));

import { DELETE } from "./route";

function callDelete(id = "u2") {
  return DELETE(new Request(`http://test/api/admin/users/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdminMock.mockResolvedValue({ id: "admin-1", email: "a@example.com", role: "ADMIN" });
  userFindUnique.mockResolvedValue({ role: "USER" });
  userCount.mockResolvedValue(2);
  deleteAccountMock.mockResolvedValue(true);
});

describe("DELETE /api/admin/users/[id]", () => {
  it("answers 403 to a non-admin", async () => {
    requireAdminMock.mockResolvedValue(null);
    const res = await callDelete();
    expect(res.status).toBe(403);
    expect(deleteAccountMock).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown user", async () => {
    userFindUnique.mockResolvedValue(null);
    const res = await callDelete();
    expect(res.status).toBe(404);
    expect(deleteAccountMock).not.toHaveBeenCalled();
  });

  it("refuses to delete the last admin", async () => {
    userFindUnique.mockResolvedValue({ role: "ADMIN" });
    userCount.mockResolvedValue(1);
    const res = await callDelete();
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "lastAdminDelete" });
    expect(deleteAccountMock).not.toHaveBeenCalled();
  });

  it("deletes the user", async () => {
    const res = await callDelete();
    expect(res.status).toBe(200);
    expect(deleteAccountMock).toHaveBeenCalledWith("u2");
  });

  it("reports a failed image cleanup instead of swallowing it", async () => {
    // Was `deleteObject(...).catch(() => {})`: the row went away and the image
    // stayed behind, orphaned and still retrievable through app/api/image.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    deleteAccountMock.mockRejectedValue(new StorageCleanupError("puzzles/a.webp"));

    const res = await callDelete();

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual({ error: "storageFailed" });
    expect(logged).toHaveBeenCalled();
  });

  it("answers 404 when the row is already gone", async () => {
    deleteAccountMock.mockResolvedValue(false);
    const res = await callDelete();
    expect(res.status).toBe(404);
  });
});
