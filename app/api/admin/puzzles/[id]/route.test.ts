import { beforeEach, describe, expect, it, vi } from "vitest";

// The write statements are spied twice: once on the transaction client the
// callback receives (tx*), once on the bare prisma client (unscoped*). Sharing
// one spy would let a refactor move the delete or the report resolution out of
// the transaction without any test noticing — atomicity is the whole point of
// this route.
const {
  requireAdminMock,
  puzzleFindUnique,
  puzzleFindFirst,
  unscopedPuzzleDeleteMany,
  unscopedReportUpdateMany,
  txPuzzleDeleteMany,
  txReportFindFirst,
  txReportUpdateMany,
  transactionMock,
  deleteObjectMock,
  sendTakedownNoticeMock,
} = vi.hoisted(() => ({
  requireAdminMock: vi.fn(),
  puzzleFindUnique: vi.fn(),
  puzzleFindFirst: vi.fn(),
  unscopedPuzzleDeleteMany: vi.fn(),
  unscopedReportUpdateMany: vi.fn(),
  txPuzzleDeleteMany: vi.fn(),
  txReportFindFirst: vi.fn(),
  txReportUpdateMany: vi.fn(),
  transactionMock: vi.fn(),
  deleteObjectMock: vi.fn(),
  sendTakedownNoticeMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ requireAdmin: requireAdminMock }));
vi.mock("@/lib/db", () => ({
  prisma: {
    puzzle: {
      findUnique: puzzleFindUnique,
      findFirst: puzzleFindFirst,
      deleteMany: unscopedPuzzleDeleteMany,
    },
    report: { findFirst: vi.fn(), updateMany: unscopedReportUpdateMany },
    $transaction: transactionMock,
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
  owner: { email: "owner@example.com", locale: "it" },
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
  txPuzzleDeleteMany.mockResolvedValue({ count: 1 });
  txReportFindFirst.mockResolvedValue({ category: "NSFW" });
  txReportUpdateMany.mockResolvedValue({ count: 1 });
  transactionMock.mockImplementation(async (fn) =>
    fn({
      puzzle: { deleteMany: txPuzzleDeleteMany },
      report: { findFirst: txReportFindFirst, updateMany: txReportUpdateMany },
    }),
  );
  deleteObjectMock.mockResolvedValue(undefined);
  sendTakedownNoticeMock.mockResolvedValue(undefined);
});

describe("DELETE /api/admin/puzzles/[id]", () => {
  it("answers 403 to a non-admin and touches nothing", async () => {
    requireAdminMock.mockResolvedValue(null);
    const res = await callDelete();
    expect(res.status).toBe(403);
    expect(deleteObjectMock).not.toHaveBeenCalled();
    expect(txPuzzleDeleteMany).not.toHaveBeenCalled();
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
      txPuzzleDeleteMany.mock.invocationCallOrder[0],
    );
  });

  it("answers 502 and keeps the row when the storage delete fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    deleteObjectMock.mockRejectedValue(new Error("AccessDenied"));
    const res = await callDelete();
    expect(res.status).toBe(502);
    expect(txPuzzleDeleteMany).not.toHaveBeenCalled();
    expect(txReportUpdateMany).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("keeps the storage object when another puzzle still references the key", async () => {
    puzzleFindFirst.mockResolvedValue({ id: "other" });
    const res = await callDelete();
    expect(res.status).toBe(200);
    expect(deleteObjectMock).not.toHaveBeenCalled();
    expect(txPuzzleDeleteMany).toHaveBeenCalledWith({ where: { id: "p1" } });
  });

  it("resolves and anonymizes every open report of the puzzle", async () => {
    await callDelete();
    expect(txReportUpdateMany).toHaveBeenCalledWith({
      where: { puzzleId: "p1", status: "OPEN" },
      data: expect.objectContaining({
        status: "TAKEDOWN",
        reporterEmail: null,
        reporterIpHash: null,
        resolvedAt: expect.any(Date),
      }),
    });
  });

  it("runs the row delete and the report resolution in one transaction", async () => {
    await callDelete();
    expect(transactionMock).toHaveBeenCalledTimes(1);
    // Both writes went through the transaction client, not the bare one: a
    // puzzle deleted outside the transaction could leave its reports open and
    // still carrying reporter PII.
    expect(txPuzzleDeleteMany).toHaveBeenCalledWith({ where: { id: "p1" } });
    expect(txReportUpdateMany).toHaveBeenCalled();
    expect(unscopedPuzzleDeleteMany).not.toHaveBeenCalled();
    expect(unscopedReportUpdateMany).not.toHaveBeenCalled();
  });

  it("notifies the owner with title and reported category and reports it in the body", async () => {
    const res = await callDelete();
    expect(sendTakedownNoticeMock).toHaveBeenCalledWith("owner@example.com", "Beach", "NSFW", "it");
    expect(await res.json()).toEqual({ ok: true, ownerNotified: true });
  });

  it("sends a category-less notice when no open report exists — nothing gets invented", async () => {
    txReportFindFirst.mockResolvedValue(null);
    await callDelete();
    expect(sendTakedownNoticeMock).toHaveBeenCalledWith("owner@example.com", "Beach", null, "it");
  });

  it("sends a category-less notice when the stored category is not canonical", async () => {
    txReportFindFirst.mockResolvedValue({ category: "LEGACY" });
    await callDelete();
    expect(sendTakedownNoticeMock).toHaveBeenCalledWith("owner@example.com", "Beach", null, "it");
  });

  it("writes the notice in the owner's language, not the acting admin's", async () => {
    // The admin clicking takedown may well be browsing in German while the
    // owner they are about to mail reads Italian. Before the locale column
    // every notice went out in the default language regardless.
    await callDelete();
    expect(sendTakedownNoticeMock.mock.calls[0].at(-1)).toBe("it");
  });

  it("answers 200 with ownerNotified=false when the owner mail fails, and logs it", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    sendTakedownNoticeMock.mockRejectedValue(new Error("smtp down"));
    const res = await callDelete();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ownerNotified: false });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("answers 404 when a concurrent delete raced ahead", async () => {
    txPuzzleDeleteMany.mockResolvedValue({ count: 0 });
    const res = await callDelete();
    expect(res.status).toBe(404);
    expect(txReportUpdateMany).not.toHaveBeenCalled();
  });
});
