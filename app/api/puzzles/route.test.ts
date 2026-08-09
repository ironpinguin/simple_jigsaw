import { beforeEach, describe, expect, it, vi } from "vitest";

const { findFirst, create, getSessionUserMock, reportCreate, verdictFindUnique } = vi.hoisted(
  () => ({
    findFirst: vi.fn(),
    create: vi.fn(),
    getSessionUserMock: vi.fn(),
    reportCreate: vi.fn(),
    verdictFindUnique: vi.fn(),
  }),
);

vi.mock("@/lib/db", () => ({
  prisma: {
    puzzle: { findFirst, create },
    report: { create: reportCreate },
    imageVerdict: { findUnique: verdictFindUnique },
  },
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
    // The lookup that produced the rejection only matches foreign puzzles.
    expect(findFirst).toHaveBeenCalledWith({
      where: { imageKey: BODY.imageKey, ownerId: { not: "owner-1" } },
      select: { id: true },
    });
  });

  it("allows reusing an imageKey across the caller's own puzzles", async () => {
    // findFirst resolves null because the foreign-reference lookup excludes
    // the caller's puzzles — a same-owner reuse is not a hit.
    const res = await callPost(BODY);
    expect(res.status).toBe(201);
    expect(findFirst).toHaveBeenCalledWith({
      where: { imageKey: BODY.imageKey, ownerId: { not: "owner-1" } },
      select: { id: true },
    });
    expect(create).toHaveBeenCalled();
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

describe("automatic moderation", () => {
  beforeEach(() => {
    verdictFindUnique.mockResolvedValue(null);
    reportCreate.mockResolvedValue({});
  });

  it("publishes a clean image as asked", async () => {
    verdictFindUnique.mockResolvedValue({ label: "CLEAN", score: 0.01, model: "fake" });

    const res = await callPost({ ...BODY, isPublic: true });

    expect(create.mock.calls[0][0].data.isPublic).toBe(true);
    expect(reportCreate).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toMatchObject({ pendingReview: false });
  });

  it("holds a flagged image private and queues it", async () => {
    verdictFindUnique.mockResolvedValue({ label: "FLAGGED", score: 0.97, model: "fake-1" });

    const res = await callPost({ ...BODY, isPublic: true });

    expect(create.mock.calls[0][0].data.isPublic).toBe(false);
    await expect(res.json()).resolves.toMatchObject({ pendingReview: true });
  });

  it("files the report as the server's own finding, not a person's", async () => {
    // A reporter identity here would invent a person who never reported.
    verdictFindUnique.mockResolvedValue({ label: "FLAGGED", score: 0.97, model: "fake-1" });

    await callPost({ ...BODY, isPublic: true });

    expect(reportCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          category: "AUTO_NSFW",
          status: "OPEN",
          reporterEmail: null,
          reporterIpHash: null,
        }),
      }),
    );
  });

  it("records the score and model so an admin can see why", async () => {
    verdictFindUnique.mockResolvedValue({ label: "FLAGGED", score: 0.97, model: "fake-1" });

    await callPost({ ...BODY, isPublic: true });

    const { message } = reportCreate.mock.calls[0][0].data;
    expect(message).toContain("0.97");
    expect(message).toContain("fake-1");
  });

  it("treats an unusable verdict exactly like a hit", async () => {
    verdictFindUnique.mockResolvedValue({ label: "UNKNOWN", score: 0, model: "error" });

    await callPost({ ...BODY, isPublic: true });

    expect(create.mock.calls[0][0].data.isPublic).toBe(false);
    expect(reportCreate).toHaveBeenCalled();
  });

  it("treats an image with no verdict as clean", async () => {
    // Uploaded before this feature, or in off mode.
    verdictFindUnique.mockResolvedValue(null);

    await callPost({ ...BODY, isPublic: true });

    expect(create.mock.calls[0][0].data.isPublic).toBe(true);
    expect(reportCreate).not.toHaveBeenCalled();
  });

  it("does not make a flagged puzzle public just because the user asked for private", async () => {
    verdictFindUnique.mockResolvedValue({ label: "FLAGGED", score: 0.9, model: "fake-1" });

    await callPost({ ...BODY, isPublic: false });

    expect(create.mock.calls[0][0].data.isPublic).toBe(false);
  });

  it("rejects a stored label it does not recognise instead of publishing", async () => {
    verdictFindUnique.mockResolvedValue({ label: "sortof", score: 0.5, model: "fake" });

    await callPost({ ...BODY, isPublic: true });

    expect(create.mock.calls[0][0].data.isPublic).toBe(false);
  });
});
