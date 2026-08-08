import { beforeEach, describe, expect, it, vi } from "vitest";

// The tx client gets its own spies. Sharing them with the global `prisma`
// would make the transaction boundary unobservable: a delete issued on
// `prisma` instead of `tx` runs on another connection, outside the
// transaction, and every assertion would still pass.
const {
  puzzleFindMany,
  userFindUnique,
  userDeleteMany,
  reportUpdateMany,
  txUserDeleteMany,
  txReportUpdateMany,
  txReportFindMany,
  transaction,
  deleteObjectMock,
} = vi.hoisted(() => ({
  puzzleFindMany: vi.fn(),
  userFindUnique: vi.fn(),
  userDeleteMany: vi.fn(),
  reportUpdateMany: vi.fn(),
  txUserDeleteMany: vi.fn(),
  txReportUpdateMany: vi.fn(),
  txReportFindMany: vi.fn(),
  transaction: vi.fn(),
  deleteObjectMock: vi.fn(),
}));

vi.mock("./db", () => ({
  prisma: {
    puzzle: { findMany: puzzleFindMany },
    user: { findUnique: userFindUnique, deleteMany: userDeleteMany },
    report: { updateMany: reportUpdateMany },
    $transaction: transaction,
  },
}));
vi.mock("./storage", () => ({ deleteObject: deleteObjectMock }));

import { deleteAccount, exclusiveImageKeys, StorageCleanupError } from "./account-deletion";

/**
 * findMany runs three times over two distinct queries — the owner's rows are
 * read twice. Route by the `where` so a test can state the world once instead
 * of ordering mock return values.
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
  userFindUnique.mockResolvedValue({ email: "gone@example.com" });
  txUserDeleteMany.mockResolvedValue({ count: 1 });
  txReportUpdateMany.mockResolvedValue({ count: 0 });
  txReportFindMany.mockResolvedValue([]);
  transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    Promise.resolve(
      fn({
        user: { deleteMany: txUserDeleteMany },
        report: { updateMany: txReportUpdateMany, findMany: txReportFindMany },
      }),
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
      txUserDeleteMany.mock.invocationCallOrder[0],
    );
  });

  it("spares an image another account still references", async () => {
    // Through deleteAccount, not exclusiveImageKeys: folding the key lookup
    // into the puzzle query the function already runs looks like removing a
    // redundant round-trip, and drops this guard. Deleting the object would
    // leave the other account's puzzle rendering a permanently broken image.
    withPuzzles(
      [
        { id: "p1", imageKey: "puzzles/shared.webp" },
        { id: "p2", imageKey: "puzzles/own.webp" },
      ],
      ["puzzles/shared.webp"],
    );

    await deleteAccount("u1");

    expect(deleteObjectMock.mock.calls.map((c) => c[0])).toEqual(["puzzles/own.webp"]);
  });

  it("issues the row delete and the report resolution on the transaction client", async () => {
    // On `prisma` instead of `tx` they run outside the transaction, on another
    // connection — the puzzles could go while their reports stay OPEN, holding
    // the reporter's email and IP hash.
    withPuzzles([{ id: "p1", imageKey: "puzzles/a.webp" }]);

    await deleteAccount("u1");

    expect(txUserDeleteMany).toHaveBeenCalledTimes(1);
    expect(txReportUpdateMany).toHaveBeenCalledTimes(1);
    expect(userDeleteMany).not.toHaveBeenCalled();
    expect(reportUpdateMany).not.toHaveBeenCalled();
  });

  it("leaves every row in place when a storage delete fails", async () => {
    withPuzzles([
      { id: "p1", imageKey: "puzzles/a.webp" },
      { id: "p2", imageKey: "puzzles/b.webp" },
    ]);
    deleteObjectMock.mockRejectedValueOnce(new Error("AccessDenied"));

    await expect(deleteAccount("u1")).rejects.toBeInstanceOf(StorageCleanupError);

    expect(txUserDeleteMany).not.toHaveBeenCalled();
    expect(txReportUpdateMany).not.toHaveBeenCalled();
    // Stops at the first failure instead of hammering a broken backend.
    expect(deleteObjectMock).toHaveBeenCalledTimes(1);
  });

  it("names the key that failed, the ones already gone, and the original error", async () => {
    // The failure is provoked on the *second* key: with only the first one
    // failing, reporting `keys[0]` unconditionally would pass, and the log
    // would point the operator at the wrong object.
    withPuzzles([
      { id: "p1", imageKey: "puzzles/a.webp" },
      { id: "p2", imageKey: "puzzles/b.webp" },
      { id: "p3", imageKey: "puzzles/c.webp" },
    ]);
    const cause = new Error("AccessDenied");
    deleteObjectMock.mockResolvedValueOnce(undefined).mockRejectedValueOnce(cause);

    await expect(deleteAccount("u1")).rejects.toMatchObject({
      key: "puzzles/b.webp",
      // The partial state: without this the operator cannot tell that a.webp
      // is already gone while its puzzle row survives.
      deleted: ["puzzles/a.webp"],
      cause,
    });
    expect(deleteObjectMock).toHaveBeenCalledTimes(2);
  });

  it("propagates a transaction failure as itself, not as a storage error", async () => {
    // Every image is gone by then, so the caller must not answer "the object
    // store is down, retry" — that would hide a real bug behind a 502.
    withPuzzles([{ id: "p1", imageKey: "puzzles/a.webp" }]);
    transaction.mockRejectedValue(new Error("database is locked"));

    await expect(deleteAccount("u1")).rejects.toThrow("database is locked");
    await expect(deleteAccount("u1")).rejects.not.toBeInstanceOf(StorageCleanupError);
  });

  it("resolves and anonymizes the open reports of the deleted puzzles", async () => {
    // Report has no foreign key to Puzzle, so nothing resolves them
    // automatically — they would sit in the open queue pointing at rows that
    // no longer exist, with the reporter's email and IP hash retained.
    withPuzzles([
      { id: "p1", imageKey: "puzzles/a.webp" },
      { id: "p2", imageKey: "puzzles/b.webp" },
    ]);

    await deleteAccount("u1");

    expect(txReportUpdateMany).toHaveBeenCalledWith({
      where: { puzzleId: { in: ["p1", "p2"] }, status: "OPEN" },
      data: expect.objectContaining({
        // Not TAKEDOWN: nobody reviewed these, and a self-deleting user must
        // not be able to book a removal an admin never made.
        status: "ACCOUNT_DELETED",
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
    expect(txReportUpdateMany).not.toHaveBeenCalled();
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });

  it("reports a concurrent delete instead of throwing", async () => {
    txUserDeleteMany.mockResolvedValue({ count: 0 });
    await expect(deleteAccount("u1")).resolves.toBe(false);
  });

  it("leaves a trace when pending reports vanish with the account", async () => {
    // An abuse case leaving the queue without an admin ever seeing it must not
    // be silent, even though there is nothing left to act on.
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    withPuzzles([{ id: "p1", imageKey: "puzzles/a.webp" }]);
    txReportUpdateMany.mockResolvedValue({ count: 2 });

    await deleteAccount("u1");

    expect(warned).toHaveBeenCalledWith(expect.stringContaining("2 open report(s)"));
  });

  it("says nothing when the account had no reported puzzles", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    withPuzzles([{ id: "p1", imageKey: "puzzles/a.webp" }]);
    txReportUpdateMany.mockResolvedValue({ count: 0 });

    await deleteAccount("u1");

    expect(warned).not.toHaveBeenCalled();
  });

  it("strips the reporter contact from the reports the account filed", async () => {
    // Reports *about* this account's puzzles are covered by the scope above;
    // these are the ones it filed against other people, which carry the
    // address only as hand-typed text and would otherwise survive the erasure.
    txReportFindMany.mockResolvedValue([
      { id: "r1", reporterEmail: "Gone@Example.com" },
      { id: "r2", reporterEmail: "someone@example.com" },
    ]);

    await deleteAccount("u1");

    expect(txReportUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["r1"] } },
      data: { reporterEmail: null, reporterIpHash: null },
    });
  });

  it("returns false without touching storage when the account is already gone", async () => {
    userFindUnique.mockResolvedValue(null);

    await expect(deleteAccount("u1")).resolves.toBe(false);

    expect(deleteObjectMock).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("still reports a concurrent delete when the images were already removed", async () => {
    // The caller answers 404 here. That must not be read as "nothing
    // happened" — this run did destroy the objects.
    withPuzzles([{ id: "p1", imageKey: "puzzles/a.webp" }]);
    txUserDeleteMany.mockResolvedValue({ count: 0 });

    await expect(deleteAccount("u1")).resolves.toBe(false);
    expect(deleteObjectMock).toHaveBeenCalledWith("puzzles/a.webp");
  });
});
