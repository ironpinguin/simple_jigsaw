import { beforeEach, describe, expect, it, vi } from "vitest";

const { puzzleFindMany, userDeleteMany, reportUpdateMany, transaction, deleteObjectMock } =
  vi.hoisted(() => ({
    puzzleFindMany: vi.fn(),
    userDeleteMany: vi.fn(),
    reportUpdateMany: vi.fn(),
    transaction: vi.fn(),
    deleteObjectMock: vi.fn(),
  }));

vi.mock("./db", () => ({
  prisma: {
    puzzle: { findMany: puzzleFindMany },
    user: { deleteMany: userDeleteMany },
    report: { updateMany: reportUpdateMany },
    $transaction: transaction,
  },
}));
vi.mock("./storage", () => ({ deleteObject: deleteObjectMock }));

import { deleteAccount, exclusiveImageKeys, StorageCleanupError } from "./account-deletion";

/**
 * findMany is called for three different queries. Route them by their `where`
 * so a test can state the world once instead of ordering mock return values.
 */
function withPuzzles(own: { id: string; imageKey: string }[], foreignKeys: string[] = []) {
  puzzleFindMany.mockImplementation((args: { where: Record<string, unknown> }) => {
    if ("ownerId" in args.where && typeof args.where.ownerId === "object") {
      // The "still referenced by somebody else" query.
      return Promise.resolve(foreignKeys.map((imageKey) => ({ imageKey })));
    }
    return Promise.resolve(own);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  deleteObjectMock.mockResolvedValue(undefined);
  userDeleteMany.mockResolvedValue({ count: 1 });
  reportUpdateMany.mockResolvedValue({ count: 0 });
  // Run the callback against a tx client with the same mocked models.
  transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    Promise.resolve(
      fn({ user: { deleteMany: userDeleteMany }, report: { updateMany: reportUpdateMany } }),
    ),
  );
  withPuzzles([]);
});

describe("exclusiveImageKeys", () => {
  it("deduplicates keys the owner reused across their own puzzles", async () => {
    // imageKey is deliberately not unique — one object behind two puzzles must
    // not be deleted twice.
    withPuzzles([
      { id: "p1", imageKey: "puzzles/a.webp" },
      { id: "p2", imageKey: "puzzles/a.webp" },
    ]);
    expect(await exclusiveImageKeys("u1")).toEqual(["puzzles/a.webp"]);
  });

  it("keeps a key another account still references", async () => {
    // Deleting it would break a puzzle that is not being erased.
    withPuzzles(
      [
        { id: "p1", imageKey: "puzzles/shared.webp" },
        { id: "p2", imageKey: "puzzles/own.webp" },
      ],
      ["puzzles/shared.webp"],
    );
    expect(await exclusiveImageKeys("u1")).toEqual(["puzzles/own.webp"]);
  });

  it("asks nothing further when the account has no puzzles", async () => {
    withPuzzles([]);
    expect(await exclusiveImageKeys("u1")).toEqual([]);
    expect(puzzleFindMany).toHaveBeenCalledTimes(1);
  });
});

describe("deleteAccount", () => {
  it("deletes every image before touching a row", async () => {
    withPuzzles([
      { id: "p1", imageKey: "puzzles/a.webp" },
      { id: "p2", imageKey: "puzzles/b.webp" },
    ]);

    await expect(deleteAccount("u1")).resolves.toBe(true);

    expect(deleteObjectMock.mock.calls.map((c) => c[0])).toEqual([
      "puzzles/a.webp",
      "puzzles/b.webp",
    ]);
    // The ordering guarantee: no row is gone while its object is still there.
    expect(Math.max(...deleteObjectMock.mock.invocationCallOrder)).toBeLessThan(
      userDeleteMany.mock.invocationCallOrder[0],
    );
  });

  it("leaves every row in place when a storage delete fails", async () => {
    withPuzzles([
      { id: "p1", imageKey: "puzzles/a.webp" },
      { id: "p2", imageKey: "puzzles/b.webp" },
    ]);
    deleteObjectMock.mockRejectedValueOnce(new Error("AccessDenied"));

    await expect(deleteAccount("u1")).rejects.toBeInstanceOf(StorageCleanupError);

    expect(userDeleteMany).not.toHaveBeenCalled();
    expect(reportUpdateMany).not.toHaveBeenCalled();
    // Stops at the first failure instead of hammering a broken backend.
    expect(deleteObjectMock).toHaveBeenCalledTimes(1);
  });

  it("names the key that failed so the log can point at it", async () => {
    withPuzzles([{ id: "p1", imageKey: "puzzles/a.webp" }]);
    deleteObjectMock.mockRejectedValue(new Error("AccessDenied"));

    await expect(deleteAccount("u1")).rejects.toMatchObject({ key: "puzzles/a.webp" });
  });

  it("resolves and anonymizes the open reports of the deleted puzzles", async () => {
    // Report has no foreign key to Puzzle, so nothing else would ever resolve
    // them — they would stay OPEN, pointing at rows that no longer exist, with
    // the reporter's email and IP hash retained.
    withPuzzles([
      { id: "p1", imageKey: "puzzles/a.webp" },
      { id: "p2", imageKey: "puzzles/b.webp" },
    ]);

    await deleteAccount("u1");

    expect(reportUpdateMany).toHaveBeenCalledWith({
      where: { puzzleId: { in: ["p1", "p2"] }, status: "OPEN" },
      data: expect.objectContaining({
        status: "TAKEDOWN",
        reporterEmail: null,
        reporterIpHash: null,
      }),
    });
    // Same transaction as the row delete, or a failure between the two would
    // leave the puzzles gone and their reports open.
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("skips the report query for an account without puzzles", async () => {
    withPuzzles([]);
    await expect(deleteAccount("u1")).resolves.toBe(true);
    expect(reportUpdateMany).not.toHaveBeenCalled();
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });

  it("reports a concurrent delete instead of throwing", async () => {
    userDeleteMany.mockResolvedValue({ count: 0 });
    await expect(deleteAccount("u1")).resolves.toBe(false);
  });
});
