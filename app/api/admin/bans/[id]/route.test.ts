import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireAdminMock, banDelete } = vi.hoisted(() => ({
  requireAdminMock: vi.fn(),
  banDelete: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ requireAdmin: requireAdminMock }));
vi.mock("@/lib/db", () => ({ prisma: { bannedEmail: { delete: banDelete } } }));
// The key rather than the translation: these assertions are about which message
// the route picks, and pinning the German copy would break on any rewording.
vi.mock("@/lib/i18n-server", () => ({ getErrorT: async () => (key: string) => key }));

import { DELETE } from "./route";

function callDelete(id = "ban-1") {
  return DELETE(new Request(`http://test/api/admin/bans/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ id }),
  });
}

/** What Prisma throws when the row a delete names is not there. */
function notFound() {
  return Object.assign(new Error("Record to delete does not exist."), { code: "P2025" });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdminMock.mockResolvedValue(true);
  banDelete.mockResolvedValue({ id: "ban-1" });
});

describe("DELETE /api/admin/bans/[id]", () => {
  it("removes the ban", async () => {
    const res = await callDelete();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(banDelete).toHaveBeenCalledWith({ where: { id: "ban-1" } });
  });

  it("refuses anyone who is not an admin", async () => {
    requireAdminMock.mockResolvedValue(false);

    const res = await callDelete();

    expect(res.status).toBe(403);
    expect(banDelete).not.toHaveBeenCalled();
  });

  it("treats a ban that is already gone as removed", async () => {
    // Two admins on the same list, or a tab left open: the row the click names
    // is no longer there, and the outcome the admin asked for is the one they
    // already have. Reporting a failure would put a row back on their screen
    // that does not exist.
    banDelete.mockRejectedValue(notFound());

    const res = await callDelete();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("says so when the delete actually fails", async () => {
    // This used to be `.catch(() => {})` followed by `{ ok: true }`, so a
    // database that refused the delete answered exactly like a success: the
    // row vanished from the admin's table and stayed in the table that counts.
    // Silently unbanning someone is the wrong way round to fail (#56).
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    banDelete.mockRejectedValue(new Error("SQLITE_BUSY"));

    const res = await callDelete();

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "serverError" });
    expect(String(error.mock.calls[0][0])).toContain("[admin]");
    error.mockRestore();
  });
});
