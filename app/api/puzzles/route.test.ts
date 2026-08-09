import { beforeEach, describe, expect, it, vi } from "vitest";

// The tx client gets its own spies, separate from the bare `prisma` ones.
// Sharing them would make the transaction boundary unobservable: a create
// issued on `prisma` instead of `tx` runs on another connection, outside the
// transaction, and every assertion below would still pass. See
// lib/account-deletion.test.ts for the same precedent.
const {
  findFirst,
  create,
  getSessionUserMock,
  reportCreate,
  verdictFindUnique,
  transaction,
  txCreate,
  txReportCreate,
} = vi.hoisted(() => ({
  findFirst: vi.fn(),
  create: vi.fn(),
  getSessionUserMock: vi.fn(),
  reportCreate: vi.fn(),
  verdictFindUnique: vi.fn(),
  transaction: vi.fn(),
  txCreate: vi.fn(),
  txReportCreate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    puzzle: { findFirst, create },
    report: { create: reportCreate },
    imageVerdict: { findUnique: verdictFindUnique },
    $transaction: transaction,
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
  txCreate.mockResolvedValue({ id: "p1" });
  txReportCreate.mockResolvedValue({});
  transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    Promise.resolve(
      fn({
        puzzle: { create: txCreate },
        report: { create: txReportCreate },
      }),
    ),
  );
});

describe("POST /api/puzzles", () => {
  it("requires login", async () => {
    getSessionUserMock.mockResolvedValue(null);
    const res = await callPost(BODY);
    expect(res.status).toBe(401);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects an imageKey already referenced by another user's puzzle", async () => {
    findFirst.mockResolvedValue({ id: "other-puzzle" });
    const res = await callPost(BODY);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("invalidInput");
    expect(transaction).not.toHaveBeenCalled();
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
    expect(txCreate).toHaveBeenCalled();
  });

  it("creates the puzzle with a fresh imageKey, defaulting isPublic to true", async () => {
    const res = await callPost(BODY);
    expect(res.status).toBe(201);
    expect(findFirst).toHaveBeenCalledWith({
      where: { imageKey: BODY.imageKey, ownerId: { not: "owner-1" } },
      select: { id: true },
    });
    expect(txCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isPublic: true, ownerId: "owner-1" }),
      }),
    );
  });

  it("creates the puzzle with isPublic: false when explicitly requested", async () => {
    const res = await callPost({ ...BODY, isPublic: false });
    expect(res.status).toBe(201);
    expect(txCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isPublic: false }),
      }),
    );
  });
});

describe("automatic moderation", () => {
  beforeEach(() => {
    verdictFindUnique.mockResolvedValue(null);
  });

  it("publishes a clean image as asked", async () => {
    verdictFindUnique.mockResolvedValue({ label: "CLEAN", score: 0.01, model: "fake" });

    const res = await callPost({ ...BODY, isPublic: true });

    expect(txCreate.mock.calls[0][0].data.isPublic).toBe(true);
    expect(txReportCreate).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toEqual({ id: "p1", pendingReview: false });
  });

  it("holds a flagged image private and queues it", async () => {
    verdictFindUnique.mockResolvedValue({ label: "FLAGGED", score: 0.97, model: "fake-1" });

    const res = await callPost({ ...BODY, isPublic: true });

    expect(txCreate.mock.calls[0][0].data.isPublic).toBe(false);
    expect(txReportCreate).toHaveBeenCalled();
    await expect(res.json()).resolves.toEqual({ id: "p1", pendingReview: true });
  });

  it("performs the puzzle write and its report on the transaction client, not the bare one", async () => {
    // A report failure after a bare prisma.puzzle.create would leave that
    // puzzle row behind: private, and invisible to admins, since the queue
    // entry never gets written. Wrapping both in one transaction means a
    // real database rolls the puzzle back too when the report insert fails.
    verdictFindUnique.mockResolvedValue({ label: "FLAGGED", score: 0.97, model: "fake-1" });

    await callPost({ ...BODY, isPublic: true });

    expect(txCreate).toHaveBeenCalled();
    expect(txReportCreate).toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(reportCreate).not.toHaveBeenCalled();
  });

  it("files the report as the server's own finding, not a person's", async () => {
    // A reporter identity here would invent a person who never reported.
    verdictFindUnique.mockResolvedValue({ label: "FLAGGED", score: 0.97, model: "fake-1" });

    await callPost({ ...BODY, isPublic: true });

    expect(txReportCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          puzzleId: "p1",
          puzzleTitle: BODY.title,
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

    const { message } = txReportCreate.mock.calls[0][0].data;
    expect(message).toContain("0.97");
    expect(message).toContain("fake-1");
  });

  it("names the guard's own UNKNOWN in the message for a genuine classifier failure", async () => {
    verdictFindUnique.mockResolvedValue({ label: "UNKNOWN", score: 0, model: "error" });

    await callPost({ ...BODY, isPublic: true });

    const { message } = txReportCreate.mock.calls[0][0].data;
    expect(message).toContain("UNKNOWN");
  });

  it("names the raw stored label in the message when it can't be narrowed, not UNKNOWN", async () => {
    // A column value nothing in this code recognises is version skew or
    // corruption — a different, more alarming situation than the guard's
    // genuine UNKNOWN (classifier timeout, meaningless score of 0). An admin
    // must be able to tell them apart instead of seeing "UNKNOWN" for both.
    verdictFindUnique.mockResolvedValue({ label: "sortof", score: 0.5, model: "fake" });

    await callPost({ ...BODY, isPublic: true });

    const { message } = txReportCreate.mock.calls[0][0].data;
    expect(message).toContain("sortof");
    expect(message).not.toContain("UNKNOWN");
  });

  it("treats an unusable verdict exactly like a hit", async () => {
    verdictFindUnique.mockResolvedValue({ label: "UNKNOWN", score: 0, model: "error" });

    await callPost({ ...BODY, isPublic: true });

    expect(txCreate.mock.calls[0][0].data.isPublic).toBe(false);
    expect(txReportCreate).toHaveBeenCalled();
  });

  it("treats an image with no verdict as clean", async () => {
    // Uploaded before this feature, or in off mode.
    verdictFindUnique.mockResolvedValue(null);

    await callPost({ ...BODY, isPublic: true });

    expect(txCreate.mock.calls[0][0].data.isPublic).toBe(true);
    expect(txReportCreate).not.toHaveBeenCalled();
  });

  it("does not make a flagged puzzle public just because the user asked for private", async () => {
    verdictFindUnique.mockResolvedValue({ label: "FLAGGED", score: 0.9, model: "fake-1" });

    await callPost({ ...BODY, isPublic: false });

    expect(txCreate.mock.calls[0][0].data.isPublic).toBe(false);
  });

  it("rejects a stored label it does not recognise instead of publishing", async () => {
    verdictFindUnique.mockResolvedValue({ label: "sortof", score: 0.5, model: "fake" });

    await callPost({ ...BODY, isPublic: true });

    expect(txCreate.mock.calls[0][0].data.isPublic).toBe(false);
    expect(txReportCreate).toHaveBeenCalled();
  });
});
