import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  findUnique,
  findFirst,
  updateMany,
  deleteMany,
  deleteObjectMock,
  getSessionViewerMock,
  getSessionUserMock,
} = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  updateMany: vi.fn(),
  deleteMany: vi.fn(),
  deleteObjectMock: vi.fn(),
  getSessionViewerMock: vi.fn(),
  getSessionUserMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { puzzle: { findUnique, findFirst, updateMany, deleteMany } },
}));
vi.mock("@/lib/auth", () => ({
  getSessionViewer: getSessionViewerMock,
  getSessionUser: getSessionUserMock,
}));
vi.mock("@/lib/storage", () => ({ deleteObject: deleteObjectMock }));
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
  deleteObjectMock.mockResolvedValue(undefined);
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

  it("answers 404 for a non-owner so it does not confirm the puzzle exists", async () => {
    getSessionUserMock.mockResolvedValue({ id: "stranger", role: "USER" });
    updateMany.mockResolvedValue({ count: 0 });
    const res = await callPatch({ isPublic: true });
    expect(res.status).toBe(404);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "p1", ownerId: "stranger" },
      data: { isPublic: true },
    });
  });

  it("answers 404 to an admin who does not own the puzzle — visibility is the owner's call", async () => {
    getSessionUserMock.mockResolvedValue({ id: "admin-1", role: "ADMIN" });
    updateMany.mockResolvedValue({ count: 0 });
    const res = await callPatch({ isPublic: true });
    expect(res.status).toBe(404);
  });

  it("answers 404 for a missing puzzle", async () => {
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
