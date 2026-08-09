import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  findUnique,
  findFirst,
  updateMany,
  deleteMany,
  reportFindFirst,
  deleteObjectMock,
  copyObjectMock,
  getSessionViewerMock,
  getSessionUserMock,
} = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  updateMany: vi.fn(),
  deleteMany: vi.fn(),
  reportFindFirst: vi.fn(),
  deleteObjectMock: vi.fn(),
  copyObjectMock: vi.fn(),
  getSessionViewerMock: vi.fn(),
  getSessionUserMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    puzzle: { findUnique, findFirst, updateMany, deleteMany },
    report: { findFirst: reportFindFirst },
  },
}));
vi.mock("@/lib/auth", () => ({
  getSessionViewer: getSessionViewerMock,
  getSessionUser: getSessionUserMock,
}));
vi.mock("@/lib/storage", () => ({ deleteObject: deleteObjectMock, copyObject: copyObjectMock }));
vi.mock("@/lib/i18n-server", () => ({
  getErrorT: async () => (key: string) => key,
}));

import { DELETE, GET, PATCH } from "./route";

const PUZZLE = {
  id: "p1",
  title: "T",
  imageKey: "puzzles/abc.webp",
  imageWidth: 800,
  imageHeight: 600,
  pieceCount: 48,
  cols: 8,
  rows: 6,
  seed: 7,
  isPublic: false,
  createdAt: new Date("2026-01-01"),
  ownerId: "owner-1",
};

function callGet() {
  return GET(new Request("http://test/api/puzzles/p1"), {
    params: Promise.resolve({ id: "p1" }),
  });
}

function callPatch(body: unknown) {
  return PATCH(
    new Request("http://test/api/puzzles/p1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "p1" }) },
  );
}

function callDelete() {
  return DELETE(new Request("http://test/api/puzzles/p1", { method: "DELETE" }), {
    params: Promise.resolve({ id: "p1" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue(PUZZLE);
  findFirst.mockResolvedValue(null);
  updateMany.mockResolvedValue({ count: 1 });
  deleteMany.mockResolvedValue({ count: 1 });
  reportFindFirst.mockResolvedValue(null);
  deleteObjectMock.mockResolvedValue(undefined);
  copyObjectMock.mockResolvedValue(undefined);
});

describe("GET /api/puzzles/[id]", () => {
  it("returns 404 (not 403) for a private puzzle to a stranger", async () => {
    getSessionViewerMock.mockResolvedValue({ id: "stranger", role: "USER" });
    const res = await callGet();
    expect(res.status).toBe(404);
  });

  it("returns 404 for a private puzzle to an anonymous visitor", async () => {
    getSessionViewerMock.mockResolvedValue(null);
    const res = await callGet();
    expect(res.status).toBe(404);
  });

  it("returns the private puzzle to its owner, without the ownerId", async () => {
    getSessionViewerMock.mockResolvedValue({ id: "owner-1", role: "USER" });
    const res = await callGet();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.puzzle).toMatchObject({ id: "p1", title: "T", isPublic: false });
    expect(body.puzzle).not.toHaveProperty("ownerId");
  });

  it("returns the private puzzle to an admin", async () => {
    getSessionViewerMock.mockResolvedValue({ id: "admin-1", role: "ADMIN" });
    const res = await callGet();
    expect(res.status).toBe(200);
  });

  it("returns a public puzzle without auth", async () => {
    findUnique.mockResolvedValue({ ...PUZZLE, isPublic: true });
    const res = await callGet();
    expect(res.status).toBe(200);
    expect(getSessionViewerMock).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/puzzles/[id]", () => {
  it("requires login", async () => {
    getSessionUserMock.mockResolvedValue(null);
    const res = await callPatch({ isPublic: true });
    expect(res.status).toBe(401);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("rejects a body without a boolean isPublic", async () => {
    getSessionUserMock.mockResolvedValue({ id: "owner-1", role: "USER" });
    const res = await callPatch({ isPublic: "yes" });
    expect(res.status).toBe(400);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("answers 404 for a non-owner so it does not confirm the puzzle exists, without ever writing", async () => {
    // The ownership pre-check intercepts before updateMany is reached — a
    // non-owner must not be able to tell, from the response, whether the
    // puzzle even exists.
    getSessionUserMock.mockResolvedValue({ id: "stranger", role: "USER" });
    const res = await callPatch({ isPublic: true });
    expect(res.status).toBe(404);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("answers 404 to an admin who does not own the puzzle — visibility is the owner's call", async () => {
    getSessionUserMock.mockResolvedValue({ id: "admin-1", role: "ADMIN" });
    const res = await callPatch({ isPublic: true });
    expect(res.status).toBe(404);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("answers 404 for a missing puzzle", async () => {
    getSessionUserMock.mockResolvedValue({ id: "owner-1", role: "USER" });
    findUnique.mockResolvedValue(null);
    const res = await callPatch({ isPublic: true });
    expect(res.status).toBe(404);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("answers 404 for a missing puzzle when only the update itself races to zero", async () => {
    // Belt and braces: the ownerId scope on updateMany is the real
    // authorisation, not the read above, so a concurrent delete between the
    // two must still 404 rather than report success.
    getSessionUserMock.mockResolvedValue({ id: "owner-1", role: "USER" });
    updateMany.mockResolvedValue({ count: 0 });
    const res = await callPatch({ isPublic: true });
    expect(res.status).toBe(404);
  });

  it("lets the owner change visibility and returns the new state", async () => {
    getSessionUserMock.mockResolvedValue({ id: "owner-1", role: "USER" });
    const res = await callPatch({ isPublic: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ puzzle: { id: "p1", isPublic: true } });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "p1", ownerId: "owner-1" },
      data: { isPublic: true },
    });
  });
});

describe("publishing a puzzle held for review", () => {
  beforeEach(() => {
    getSessionUserMock.mockResolvedValue({ id: "owner-1", role: "USER" });
  });

  it("refuses while an automatic report is still open", async () => {
    // Otherwise the uploader clears their own hold before an admin ever sees
    // the queue entry, and the classifier is decorative.
    reportFindFirst.mockResolvedValue({ id: "r1" });

    const res = await callPatch({ isPublic: true });

    expect(res.status).toBe(409);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("looks only for an unresolved machine finding on this puzzle", async () => {
    // A user report does not block publishing — that is #22's behaviour and
    // this feature must not change it — and a resolved one is spent. The
    // category filter is `in` a list, not `equals` a literal, so a second
    // machine category added later is covered without touching this check.
    await callPatch({ isPublic: true });

    expect(reportFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { puzzleId: "p1", category: { in: ["AUTO_NSFW"] }, status: "OPEN" },
      }),
    );
  });

  it("gives a non-owner the same 404 whether or not the puzzle is held — no existence or moderation-state oracle", async () => {
    // Before the ownership pre-check, a stranger sending an arbitrary id
    // could distinguish "not mine" (404) from "held" (409) — leaking both
    // that the puzzle exists and that it is under moderation. The hold
    // lookup must never even run for a non-owner.
    getSessionUserMock.mockResolvedValue({ id: "stranger", role: "USER" });
    reportFindFirst.mockResolvedValue({ id: "r1" });

    const res = await callPatch({ isPublic: true });

    expect(res.status).toBe(404);
    expect(reportFindFirst).not.toHaveBeenCalled();
  });

  it("gives a non-owner admin the same 404, held or not — visibility is the owner's call", async () => {
    getSessionUserMock.mockResolvedValue({ id: "admin-1", role: "ADMIN" });
    reportFindFirst.mockResolvedValue({ id: "r1" });

    const res = await callPatch({ isPublic: true });

    expect(res.status).toBe(404);
    expect(reportFindFirst).not.toHaveBeenCalled();
  });

  it("publishes normally when nothing is holding it", async () => {
    reportFindFirst.mockResolvedValue(null);

    const res = await callPatch({ isPublic: true });

    expect(res.status).toBe(200);
    expect(updateMany).toHaveBeenCalled();
  });

  it("never blocks making a puzzle private", async () => {
    // A hold must not trap someone into keeping their own puzzle public.
    reportFindFirst.mockResolvedValue({ id: "r1" });

    const res = await callPatch({ isPublic: false });

    expect(res.status).toBe(200);
  });
});

describe("DELETE /api/puzzles/[id]", () => {
  it("requires login", async () => {
    getSessionUserMock.mockResolvedValue(null);
    const res = await callDelete();
    expect(res.status).toBe(401);
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("answers 404 for a non-owner so it does not confirm the puzzle exists", async () => {
    getSessionUserMock.mockResolvedValue({ id: "stranger", role: "USER" });
    const res = await callDelete();
    expect(res.status).toBe(404);
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("answers 404 to an admin who does not own the puzzle", async () => {
    getSessionUserMock.mockResolvedValue({ id: "admin-1", role: "ADMIN" });
    const res = await callDelete();
    expect(res.status).toBe(404);
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("answers 404 for a missing puzzle", async () => {
    getSessionUserMock.mockResolvedValue({ id: "owner-1", role: "USER" });
    findUnique.mockResolvedValue(null);
    const res = await callDelete();
    expect(res.status).toBe(404);
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("deletes the puzzle and removes the storage object when no other puzzle references the key", async () => {
    getSessionUserMock.mockResolvedValue({ id: "owner-1", role: "USER" });
    const res = await callDelete();
    expect(res.status).toBe(200);
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: "p1", ownerId: "owner-1" } });
    expect(findFirst).toHaveBeenCalledWith({
      where: { imageKey: PUZZLE.imageKey, id: { not: "p1" } },
      select: { id: true },
    });
    expect(deleteObjectMock).toHaveBeenCalledWith(PUZZLE.imageKey);
  });

  it("checks for other references before deleting the row, so a failed check cannot report failure for a completed delete", async () => {
    getSessionUserMock.mockResolvedValue({ id: "owner-1", role: "USER" });
    await callDelete();
    expect(findFirst.mock.invocationCallOrder[0]).toBeLessThan(
      deleteMany.mock.invocationCallOrder[0],
    );
  });

  it("answers 404 and leaves storage untouched when a concurrent delete raced ahead", async () => {
    getSessionUserMock.mockResolvedValue({ id: "owner-1", role: "USER" });
    deleteMany.mockResolvedValue({ count: 0 });
    const res = await callDelete();
    expect(res.status).toBe(404);
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });

  it("does not delete the storage object when another puzzle still references the imageKey", async () => {
    getSessionUserMock.mockResolvedValue({ id: "owner-1", role: "USER" });
    findFirst.mockResolvedValue({ id: "other-puzzle" });
    const res = await callDelete();
    expect(res.status).toBe(200);
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: "p1", ownerId: "owner-1" } });
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });

  it("still succeeds when the storage cleanup fails, but logs the failure", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    getSessionUserMock.mockResolvedValue({ id: "owner-1", role: "USER" });
    deleteObjectMock.mockRejectedValue(new Error("AccessDenied"));
    const res = await callDelete();
    expect(res.status).toBe(200);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("PATCH /api/puzzles/[id] — imageKey rotation", () => {
  function flipPrivate() {
    return callPatch({ isPublic: false });
  }

  beforeEach(() => {
    getSessionUserMock.mockResolvedValue({ id: "owner-1", role: "USER" });
    findUnique.mockResolvedValue({ ...PUZZLE, isPublic: true });
  });

  it("rotates the imageKey when the owner flips a public puzzle to private", async () => {
    const res = await flipPrivate();
    expect(res.status).toBe(200);
    expect(copyObjectMock).toHaveBeenCalledTimes(1);
    const [src, dest] = copyObjectMock.mock.calls[0];
    expect(src).toBe(PUZZLE.imageKey);
    expect(dest).toMatch(/^puzzles\/.+\.webp$/);
    expect(dest).not.toBe(PUZZLE.imageKey);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "p1", ownerId: "owner-1", imageKey: PUZZLE.imageKey },
      data: { isPublic: false, imageKey: dest },
    });
    expect(deleteObjectMock).toHaveBeenCalledWith(PUZZLE.imageKey);
    // The client renders thumbnails from imageKey — without the new key in
    // the response, the list keeps pointing at the rotated-away (404) key.
    expect(await res.json()).toEqual({ puzzle: { id: "p1", isPublic: false, imageKey: dest } });
  });

  it("copies before the row update, deletes the old object after it", async () => {
    await flipPrivate();
    expect(copyObjectMock.mock.invocationCallOrder[0]).toBeLessThan(
      updateMany.mock.invocationCallOrder[0],
    );
    expect(updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      deleteObjectMock.mock.invocationCallOrder[0],
    );
  });

  it("fails the flip with 502 when the copy fails, leaving the puzzle public", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    copyObjectMock.mockRejectedValue(new Error("NoSuchKey"));
    const res = await flipPrivate();
    expect(res.status).toBe(502);
    expect(updateMany).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("keeps the old object when another puzzle still references the key", async () => {
    findFirst.mockResolvedValue({ id: "other-puzzle" });
    const res = await flipPrivate();
    expect(res.status).toBe(200);
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });

  it("does not rotate a puzzle that is already private", async () => {
    findUnique.mockResolvedValue({ ...PUZZLE, isPublic: false });
    const res = await flipPrivate();
    expect(res.status).toBe(200);
    expect(copyObjectMock).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({
      puzzle: { id: "p1", isPublic: false, imageKey: PUZZLE.imageKey },
    });
  });

  it("answers 404 to a non-owner without touching storage", async () => {
    getSessionUserMock.mockResolvedValue({ id: "stranger", role: "USER" });
    const res = await flipPrivate();
    expect(res.status).toBe(404);
    expect(copyObjectMock).not.toHaveBeenCalled();
  });

  it("cleans up the copied object and answers 404 when the row update raced to zero", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    updateMany.mockResolvedValue({ count: 0 });
    const res = await flipPrivate();
    expect(res.status).toBe(404);
    const dest = copyObjectMock.mock.calls[0][1];
    expect(deleteObjectMock).toHaveBeenCalledWith(dest);
    errorSpy.mockRestore();
  });

  it("still flips to private when only the old-object cleanup fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    deleteObjectMock.mockRejectedValue(new Error("AccessDenied"));
    const res = await flipPrivate();
    expect(res.status).toBe(200);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
