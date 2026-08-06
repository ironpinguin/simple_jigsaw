import { beforeEach, describe, expect, it, vi } from "vitest";

const { findFirst, create, getSessionUserMock } = vi.hoisted(() => ({
  findFirst: vi.fn(),
  create: vi.fn(),
  getSessionUserMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { puzzle: { findFirst, create } },
}));
vi.mock("@/lib/auth", () => ({ getSessionUser: getSessionUserMock }));
vi.mock("@/lib/i18n-server", () => ({
  getErrorT: async () => (key: string) => key,
}));

import { POST } from "./route";

const BODY = {
  title: "My puzzle",
  imageKey: "puzzles/abc.webp",
  imageWidth: 800,
  imageHeight: 600,
  pieceCount: 48,
};

function callPost(body: unknown) {
  return POST(
    new Request("http://test/api/puzzles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getSessionUserMock.mockResolvedValue({ id: "owner-1", role: "USER" });
  findFirst.mockResolvedValue(null);
  create.mockResolvedValue({ id: "p1" });
});

describe("POST /api/puzzles", () => {
  it("requires login", async () => {
    getSessionUserMock.mockResolvedValue(null);
    const res = await callPost(BODY);
    expect(res.status).toBe(401);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects an imageKey already referenced by another user's puzzle", async () => {
    findFirst.mockResolvedValue({ id: "other-puzzle" });
    const res = await callPost(BODY);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("invalidInput");
    expect(create).not.toHaveBeenCalled();
  });

  it("creates the puzzle with a fresh imageKey, defaulting isPublic to true", async () => {
    const res = await callPost(BODY);
    expect(res.status).toBe(201);
    expect(findFirst).toHaveBeenCalledWith({
      where: { imageKey: BODY.imageKey, ownerId: { not: "owner-1" } },
      select: { id: true },
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isPublic: true, ownerId: "owner-1" }),
      }),
    );
  });

  it("creates the puzzle with isPublic: false when explicitly requested", async () => {
    const res = await callPost({ ...BODY, isPublic: false });
    expect(res.status).toBe(201);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isPublic: false }),
      }),
    );
  });
});
