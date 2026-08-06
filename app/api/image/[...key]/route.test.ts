import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany, getSessionViewerMock, getObjectMock } = vi.hoisted(() => ({
  findMany: vi.fn(),
  getSessionViewerMock: vi.fn(),
  getObjectMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: { puzzle: { findMany } } }));
vi.mock("@/lib/auth", () => ({ getSessionViewer: getSessionViewerMock }));
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
  it("resolves the puzzles referencing exactly the requested key", async () => {
    findMany.mockResolvedValue([{ isPublic: true, ownerId: "owner-1" }]);
    await callRoute();
    expect(findMany).toHaveBeenCalledWith({
      where: { imageKey: "puzzles/abc.webp" },
      select: { isPublic: true, ownerId: true },
    });
    expect(getObjectMock).toHaveBeenCalledWith("puzzles/abc.webp");
  });

  it("serves a public image without auth and with a day-long public cache", async () => {
    findMany.mockResolvedValue([{ isPublic: true, ownerId: "owner-1" }]);
    const res = await callRoute();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=86400");
    expect(getSessionViewerMock).not.toHaveBeenCalled();
  });

  it("answers 404 for a private image to an anonymous visitor without touching storage", async () => {
    findMany.mockResolvedValue([{ isPublic: false, ownerId: "owner-1" }]);
    getSessionViewerMock.mockResolvedValue(null);
    const res = await callRoute();
    expect(res.status).toBe(404);
    expect(getObjectMock).not.toHaveBeenCalled();
  });

  it("answers 404 for a private image to a different signed-in user without touching storage", async () => {
    findMany.mockResolvedValue([{ isPublic: false, ownerId: "owner-1" }]);
    getSessionViewerMock.mockResolvedValue({ id: "stranger", role: "USER" });
    const res = await callRoute();
    expect(res.status).toBe(404);
    expect(getObjectMock).not.toHaveBeenCalled();
  });

  it("serves a private image to its owner with a no-store cache header", async () => {
    findMany.mockResolvedValue([{ isPublic: false, ownerId: "owner-1" }]);
    getSessionViewerMock.mockResolvedValue({ id: "owner-1", role: "USER" });
    const res = await callRoute();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("serves a private image to an admin with a no-store cache header", async () => {
    findMany.mockResolvedValue([{ isPublic: false, ownerId: "owner-1" }]);
    getSessionViewerMock.mockResolvedValue({ id: "admin-1", role: "ADMIN" });
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

  it("serves publicly when one of several referencing puzzles is public", async () => {
    findMany.mockResolvedValue([
      { isPublic: false, ownerId: "owner-a" },
      { isPublic: true, ownerId: "owner-b" },
    ]);
    const res = await callRoute();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=86400");
    expect(getSessionViewerMock).not.toHaveBeenCalled();
  });

  it("serves privately when the viewer owns one of several private referencing puzzles", async () => {
    findMany.mockResolvedValue([
      { isPublic: false, ownerId: "owner-a" },
      { isPublic: false, ownerId: "owner-b" },
    ]);
    getSessionViewerMock.mockResolvedValue({ id: "owner-b", role: "USER" });
    const res = await callRoute();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("answers 404 when the storage object is missing (fs ENOENT / s3 NoSuchKey), but logs the drift", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    findMany.mockResolvedValue([{ isPublic: true, ownerId: "owner-1" }]);
    const enoent = Object.assign(new Error("no such file"), { code: "ENOENT" });
    getObjectMock.mockRejectedValue(enoent);
    const res = await callRoute();
    expect(res.status).toBe(404);
    // A referenced key missing in storage is an anomaly the operator must see.
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("puzzles/abc.webp"));
    errorSpy.mockRestore();
  });

  it("answers 500 and logs when storage fails for an image that should exist", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    findMany.mockResolvedValue([{ isPublic: true, ownerId: "owner-1" }]);
    getObjectMock.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const res = await callRoute();
    expect(res.status).toBe(500);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
