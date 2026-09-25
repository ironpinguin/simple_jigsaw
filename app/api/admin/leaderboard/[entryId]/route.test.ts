import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  deleteMany: vi.fn(),
  requireAdmin: vi.fn(),
  txFindUnique: vi.fn(),
  txDelete: vi.fn(),
  txUserUpdate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    leaderboardEntry: { deleteMany: m.deleteMany },
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        leaderboardEntry: { findUnique: m.txFindUnique, delete: m.txDelete },
        user: { update: m.txUserUpdate },
      }),
  },
}));
vi.mock("@/lib/auth", () => ({ requireAdmin: m.requireAdmin }));
vi.mock("@/lib/i18n-server", () => ({ getErrorT: async () => (key: string) => key }));

import { DELETE } from "./route";

const call = (query = "") =>
  DELETE(new Request(`http://test/api/admin/leaderboard/e1${query}`, { method: "DELETE" }), {
    params: Promise.resolve({ entryId: "e1" }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  m.requireAdmin.mockResolvedValue({ id: "admin-1", email: "a@example.com", role: "ADMIN" });
  m.deleteMany.mockResolvedValue({ count: 1 });
});

describe("DELETE /api/admin/leaderboard/[entryId]", () => {
  it("removes the entry for an admin", async () => {
    expect((await call()).status).toBe(200);
    expect(m.deleteMany).toHaveBeenCalledWith({ where: { id: "e1" } });
  });

  it("is admins only", async () => {
    m.requireAdmin.mockResolvedValue(null);
    expect((await call()).status).toBe(403);
    expect(m.deleteMany).not.toHaveBeenCalled();
  });

  it("also clears the solver's display name when asked to", async () => {
    m.txFindUnique.mockResolvedValue({ userId: "u7" });
    const res = await call("?resetName=1");
    expect(await res.json()).toEqual({ ok: true, nameReset: true });
    expect(m.txDelete).toHaveBeenCalledWith({ where: { id: "e1" } });
    expect(m.txUserUpdate).toHaveBeenCalledWith({
      where: { id: "u7" },
      data: { displayName: null },
    });
    expect(m.deleteMany).not.toHaveBeenCalled();
  });

  it("answers 404 and resets nothing for a gone entry with the name reset", async () => {
    m.txFindUnique.mockResolvedValue(null);
    expect((await call("?resetName=1")).status).toBe(404);
    expect(m.txUserUpdate).not.toHaveBeenCalled();
  });

  it("answers 404 for an entry that is gone", async () => {
    m.deleteMany.mockResolvedValue({ count: 0 });
    expect((await call()).status).toBe(404);
  });
});
