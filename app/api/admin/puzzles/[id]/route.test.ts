import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  requireAdminMock,
  puzzleFindUnique,
  puzzleFindFirst,
  puzzleDeleteMany,
  reportFindFirst,
  reportUpdateMany,
  deleteObjectMock,
  sendTakedownNoticeMock,
} = vi.hoisted(() => ({
  requireAdminMock: vi.fn(),
  puzzleFindUnique: vi.fn(),
  puzzleFindFirst: vi.fn(),
  puzzleDeleteMany: vi.fn(),
  reportFindFirst: vi.fn(),
  reportUpdateMany: vi.fn(),
  deleteObjectMock: vi.fn(),
  sendTakedownNoticeMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ requireAdmin: requireAdminMock }));
vi.mock("@/lib/db", () => ({
  prisma: {
    puzzle: { findUnique: puzzleFindUnique, findFirst: puzzleFindFirst, deleteMany: puzzleDeleteMany },
    report: { findFirst: reportFindFirst, updateMany: reportUpdateMany },
  },
}));
vi.mock("@/lib/storage", () => ({ deleteObject: deleteObjectMock }));
vi.mock("@/lib/mail", () => ({ sendTakedownNotice: sendTakedownNoticeMock }));
vi.mock("@/lib/i18n-server", () => ({
  getErrorT: async () => (key: string) => key,
}));

import { DELETE } from "./route";

const PUZZLE = {
  imageKey: "puzzles/abc.webp",
  title: "Beach",
  owner: { email: "owner@example.com" },
};

function callDelete() {
  return DELETE(new Request("http://test/api/admin/puzzles/p1", { method: "DELETE" }), {
    params: Promise.resolve({ id: "p1" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdminMock.mockResolvedValue({ id: "admin-1", email: "a@example.com", role: "ADMIN" });
  puzzleFindUnique.mockResolvedValue(PUZZLE);
  puzzleFindFirst.mockResolvedValue(null);
  puzzleDeleteMany.mockResolvedValue({ count: 1 });
  reportFindFirst.mockResolvedValue({ category: "NSFW" });
  reportUpdateMany.mockResolvedValue({ count: 1 });
  deleteObjectMock.mockResolvedValue(undefined);
  sendTakedownNoticeMock.mockResolvedValue(undefined);
});

describe("DELETE /api/admin/puzzles/[id]", () => {
  it("answers 403 to a non-admin and touches nothing", async () => {
    requireAdminMock.mockResolvedValue(null);
    const res = await callDelete();
    expect(res.status).toBe(403);
    expect(deleteObjectMock).not.toHaveBeenCalled();
    expect(puzzleDeleteMany).not.toHaveBeenCalled();
  });

  it("answers 404 for a missing puzzle", async () => {
    puzzleFindUnique.mockResolvedValue(null);
    const res = await callDelete();
    expect(res.status).toBe(404);
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });

  it("deletes the storage object before the row", async () => {
    const res = await callDelete();
    expect(res.status).toBe(200);
    expect(deleteObjectMock).toHaveBeenCalledWith(PUZZLE.imageKey);
    expect(deleteObjectMock.mock.invocationCallOrder[0]).toBeLessThan(
      puzzleDeleteMany.mock.invocationCallOrder[0],
    );
  });

  it("answers 502 and keeps the row when the storage delete fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    deleteObjectMock.mockRejectedValue(new Error("AccessDenied"));
    const res = await callDelete();
    expect(res.status).toBe(502);
    expect(puzzleDeleteMany).not.toHaveBeenCalled();
    expect(reportUpdateMany).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("keeps the storage object when another puzzle still references the key", async () => {
    puzzleFindFirst.mockResolvedValue({ id: "other" });
    const res = await callDelete();
    expect(res.status).toBe(200);
    expect(deleteObjectMock).not.toHaveBeenCalled();
    expect(puzzleDeleteMany).toHaveBeenCalledWith({ where: { id: "p1" } });
  });

  it("resolves and anonymizes every open report of the puzzle", async () => {
    await callDelete();
    expect(reportUpdateMany).toHaveBeenCalledWith({
      where: { puzzleId: "p1", status: "OPEN" },
      data: expect.objectContaining({
        status: "TAKEDOWN",
        reporterEmail: null,
        reporterIpHash: null,
        resolvedAt: expect.any(Date),
      }),
    });
  });

  it("notifies the owner with title and reported category", async () => {
    await callDelete();
    expect(sendTakedownNoticeMock).toHaveBeenCalledWith("owner@example.com", "Beach", "NSFW");
  });

  it("falls back to OTHER when no open report carries a category", async () => {
    reportFindFirst.mockResolvedValue(null);
    await callDelete();
    expect(sendTakedownNoticeMock).toHaveBeenCalledWith("owner@example.com", "Beach", "OTHER");
  });

  it("still answers 200 when the owner mail fails, but logs it", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    sendTakedownNoticeMock.mockRejectedValue(new Error("smtp down"));
    const res = await callDelete();
    expect(res.status).toBe(200);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("answers 404 when a concurrent delete raced ahead", async () => {
    puzzleDeleteMany.mockResolvedValue({ count: 0 });
    const res = await callDelete();
    expect(res.status).toBe(404);
    expect(reportUpdateMany).not.toHaveBeenCalled();
  });
});
