import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ deleteMany: vi.fn(), requireAdmin: vi.fn() }));

vi.mock("@/lib/db", () => ({ prisma: { leaderboardEntry: { deleteMany: m.deleteMany } } }));
vi.mock("@/lib/auth", () => ({ requireAdmin: m.requireAdmin }));
vi.mock("@/lib/i18n-server", () => ({ getErrorT: async () => (key: string) => key }));

import { DELETE } from "./route";

const call = () =>
  DELETE(new Request("http://test", { method: "DELETE" }), {
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

  it("answers 404 for an entry that is gone", async () => {
    m.deleteMany.mockResolvedValue({ count: 0 });
    expect((await call()).status).toBe(404);
  });
});
