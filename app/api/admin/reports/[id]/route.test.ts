import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireAdminMock, reportUpdateMany } = vi.hoisted(() => ({
  requireAdminMock: vi.fn(),
  reportUpdateMany: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ requireAdmin: requireAdminMock }));
vi.mock("@/lib/db", () => ({ prisma: { report: { updateMany: reportUpdateMany } } }));
vi.mock("@/lib/i18n-server", () => ({
  getErrorT: async () => (key: string) => key,
}));

import { PATCH } from "./route";

function callPatch(body: unknown) {
  return PATCH(
    new Request("http://test/api/admin/reports/r1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "r1" }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdminMock.mockResolvedValue({ id: "admin-1", email: "a@example.com", role: "ADMIN" });
  reportUpdateMany.mockResolvedValue({ count: 1 });
});

describe("PATCH /api/admin/reports/[id]", () => {
  it("answers 403 to a non-admin", async () => {
    requireAdminMock.mockResolvedValue(null);
    const res = await callPatch({ action: "dismiss" });
    expect(res.status).toBe(403);
    expect(reportUpdateMany).not.toHaveBeenCalled();
  });

  it("rejects an unknown action", async () => {
    const res = await callPatch({ action: "takedown" });
    expect(res.status).toBe(400);
    expect(reportUpdateMany).not.toHaveBeenCalled();
  });

  it("dismisses an open report and anonymizes it in the same statement", async () => {
    const res = await callPatch({ action: "dismiss" });
    expect(res.status).toBe(200);
    expect(reportUpdateMany).toHaveBeenCalledWith({
      where: { id: "r1", status: "OPEN" },
      data: expect.objectContaining({
        status: "DISMISSED",
        reporterEmail: null,
        reporterIpHash: null,
        resolvedAt: expect.any(Date),
      }),
    });
  });

  it("answers 404 for a missing or already resolved report", async () => {
    reportUpdateMany.mockResolvedValue({ count: 0 });
    const res = await callPatch({ action: "dismiss" });
    expect(res.status).toBe(404);
  });
});
