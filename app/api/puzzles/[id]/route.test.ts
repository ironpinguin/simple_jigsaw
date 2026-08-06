import { beforeEach, describe, expect, it, vi } from "vitest";

const { findUnique, update, deleteFn, authMock, getSessionUserMock } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  deleteFn: vi.fn(),
  authMock: vi.fn(),
  getSessionUserMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { puzzle: { findUnique, update, delete: deleteFn } },
}));
vi.mock("@/lib/auth", () => ({ auth: authMock, getSessionUser: getSessionUserMock }));
vi.mock("@/lib/storage", () => ({ deleteObject: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/i18n-server", () => ({
  getErrorT: async () => (key: string) => key,
}));

import { GET, PATCH } from "./route";

const PUZZLE = {
  id: "p1",
  title: "T",
  imageKey: "puzzles/abc.webp",
  isPublic: false,
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

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue(PUZZLE);
});

describe("GET /api/puzzles/[id]", () => {
  it("returns 404 (not 403) for a private puzzle to a stranger", async () => {
    authMock.mockResolvedValue({ user: { id: "stranger", role: "USER" } });
    const res = await callGet();
    expect(res.status).toBe(404);
  });

  it("returns 404 for a private puzzle to an anonymous visitor", async () => {
    authMock.mockResolvedValue(null);
    const res = await callGet();
    expect(res.status).toBe(404);
  });

  it("returns the private puzzle to its owner", async () => {
    authMock.mockResolvedValue({ user: { id: "owner-1", role: "USER" } });
    const res = await callGet();
    expect(res.status).toBe(200);
  });

  it("returns the private puzzle to an admin", async () => {
    authMock.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
    const res = await callGet();
    expect(res.status).toBe(200);
  });

  it("returns a public puzzle without auth", async () => {
    findUnique.mockResolvedValue({ ...PUZZLE, isPublic: true });
    const res = await callGet();
    expect(res.status).toBe(200);
    expect(authMock).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/puzzles/[id]", () => {
  it("requires login", async () => {
    getSessionUserMock.mockResolvedValue(null);
    const res = await callPatch({ isPublic: true });
    expect(res.status).toBe(401);
  });

  it("rejects a body without a boolean isPublic", async () => {
    getSessionUserMock.mockResolvedValue({ id: "owner-1", role: "USER" });
    const res = await callPatch({ isPublic: "yes" });
    expect(res.status).toBe(400);
  });

  it("answers 404 for a non-owner so it does not confirm the puzzle exists", async () => {
    getSessionUserMock.mockResolvedValue({ id: "stranger", role: "USER" });
    const res = await callPatch({ isPublic: true });
    expect(res.status).toBe(404);
    expect(update).not.toHaveBeenCalled();
  });

  it("lets the owner change visibility", async () => {
    getSessionUserMock.mockResolvedValue({ id: "owner-1", role: "USER" });
    update.mockResolvedValue({ id: "p1", isPublic: true });
    const res = await callPatch({ isPublic: true });
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith({
      where: { id: "p1" },
      data: { isPublic: true },
      select: { id: true, isPublic: true },
    });
  });
});
