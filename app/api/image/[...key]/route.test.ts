import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany, authMock, getObjectMock } = vi.hoisted(() => ({
  findMany: vi.fn(),
  authMock: vi.fn(),
  getObjectMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: { puzzle: { findMany } } }));
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/storage", () => ({ getObject: getObjectMock }));
vi.mock("@/lib/i18n-server", () => ({
  getErrorT: async () => (key: string) => key,
}));

import { GET } from "./route";

function callRoute() {
  return GET(new Request("http://test/api/image/puzzles/abc.webp"), {
    params: Promise.resolve({ key: ["puzzles", "abc.webp"] }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getObjectMock.mockResolvedValue({ body: Buffer.from("img"), contentType: "image/webp" });
});

describe("GET /api/image/[...key]", () => {
  it("serves a public image without auth and with the long immutable cache", async () => {
    findMany.mockResolvedValue([{ isPublic: true, ownerId: "owner-1" }]);
    const res = await callRoute();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(authMock).not.toHaveBeenCalled();
  });

  it("answers 404 for a private image to an anonymous visitor without touching storage", async () => {
    findMany.mockResolvedValue([{ isPublic: false, ownerId: "owner-1" }]);
    authMock.mockResolvedValue(null);
    const res = await callRoute();
    expect(res.status).toBe(404);
    expect(getObjectMock).not.toHaveBeenCalled();
  });

  it("answers 404 for a private image to a different signed-in user", async () => {
    findMany.mockResolvedValue([{ isPublic: false, ownerId: "owner-1" }]);
    authMock.mockResolvedValue({ user: { id: "stranger", role: "USER" } });
    const res = await callRoute();
    expect(res.status).toBe(404);
  });

  it("serves a private image to its owner with a no-store cache header", async () => {
    findMany.mockResolvedValue([{ isPublic: false, ownerId: "owner-1" }]);
    authMock.mockResolvedValue({ user: { id: "owner-1", role: "USER" } });
    const res = await callRoute();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("serves a private image to an admin with a no-store cache header", async () => {
    findMany.mockResolvedValue([{ isPublic: false, ownerId: "owner-1" }]);
    authMock.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
    const res = await callRoute();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("answers 404 for a key no puzzle references", async () => {
    findMany.mockResolvedValue([]);
    const res = await callRoute();
    expect(res.status).toBe(404);
    expect(getObjectMock).not.toHaveBeenCalled();
  });
});
