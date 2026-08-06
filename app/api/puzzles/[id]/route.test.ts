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

import { GET } from "./route";

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
