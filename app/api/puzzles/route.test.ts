import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The tx client gets its own spies, separate from the bare `prisma` ones.
// Sharing them would make the transaction boundary unobservable: a create
// issued on `prisma` instead of `tx` runs on another connection, outside the
// transaction, and every assertion below would still pass. See
// lib/account-deletion.test.ts for the same precedent.
const {
  puzzleFindMany,
  create,
  getSessionUserMock,
  reportCreate,
  verdictFindUnique,
  transaction,
  txCreate,
  txReportCreate,
  notifyAdmins,
} = vi.hoisted(() => ({
  puzzleFindMany: vi.fn(),
  create: vi.fn(),
  getSessionUserMock: vi.fn(),
  reportCreate: vi.fn(),
  verdictFindUnique: vi.fn(),
  transaction: vi.fn(),
  txCreate: vi.fn(),
  txReportCreate: vi.fn(),
  notifyAdmins: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    puzzle: { findMany: puzzleFindMany, create },
    report: { create: reportCreate },
    imageVerdict: { findUnique: verdictFindUnique },
    $transaction: transaction,
  },
}));
vi.mock("@/lib/auth", () => ({ getSessionUser: getSessionUserMock }));
// The notification's own behaviour — every admin, the no-admins log, the
// never-throws contract — is lib/report-notify.test.ts. Here only the routing
// decision matters: held notifies, clean does not.
vi.mock("@/lib/report-notify", () => ({ notifyAdminsOfReport: notifyAdmins }));
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

/**
 * The single read the route makes about who already references the key, and
 * publicly or not. Both columns are load-bearing: `ownerId` for the
 * foreign-owner rejection, `isPublic` for what a missing verdict means.
 */
const REFERENCE_LOOKUP = {
  where: { imageKey: BODY.imageKey },
  select: { ownerId: true, isPublic: true },
};

beforeEach(() => {
  vi.clearAllMocks();
  getSessionUserMock.mockResolvedValue({ id: "owner-1", role: "USER" });
  // Nobody references the key yet — the ordinary "upload, then create" flow.
  puzzleFindMany.mockResolvedValue([]);
  // Pinned rather than inherited: the route reads NSFW_MODE to decide what a
  // *missing* verdict means, and a developer with the variable set in their
  // shell must not get different results from CI.
  vi.stubEnv("NSFW_MODE", "off");
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

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/puzzles", () => {
  it("requires login", async () => {
    getSessionUserMock.mockResolvedValue(null);
    const res = await callPost(BODY);
    expect(res.status).toBe(401);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects an imageKey already referenced by another user's puzzle", async () => {
    puzzleFindMany.mockResolvedValue([{ ownerId: "someone-else", isPublic: true }]);
    const res = await callPost(BODY);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("invalidInput");
    expect(transaction).not.toHaveBeenCalled();
    expect(puzzleFindMany).toHaveBeenCalledWith(REFERENCE_LOOKUP);
  });

  it("still rejects when the caller also owns a puzzle using that key", async () => {
    // The read is no longer filtered to foreign owners, so a caller who
    // already uses the key must not shadow the stranger who also does.
    puzzleFindMany.mockResolvedValue([
      { ownerId: "owner-1", isPublic: true },
      { ownerId: "someone-else", isPublic: true },
    ]);
    const res = await callPost(BODY);
    expect(res.status).toBe(400);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("allows reusing an imageKey across the caller's own puzzles", async () => {
    puzzleFindMany.mockResolvedValue([{ ownerId: "owner-1", isPublic: true }]);
    const res = await callPost(BODY);
    expect(res.status).toBe(201);
    expect(puzzleFindMany).toHaveBeenCalledWith(REFERENCE_LOOKUP);
    expect(txCreate).toHaveBeenCalled();
  });

  it("asks who references the key exactly once", async () => {
    // The reference read serves both the rejection above and the
    // missing-verdict rule below; a second query for the second question
    // would be a second round trip on every create.
    await callPost(BODY);
    expect(puzzleFindMany).toHaveBeenCalledTimes(1);
  });

  it("creates the puzzle with a fresh imageKey, defaulting isPublic to true", async () => {
    const res = await callPost(BODY);
    expect(res.status).toBe(201);
    expect(puzzleFindMany).toHaveBeenCalledWith(REFERENCE_LOOKUP);
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

  it("treats an image with no verdict as clean when a public puzzle already uses it", async () => {
    // The case the rule exists for: an image uploaded before this feature.
    // Such an image is always already attached to the puzzle it was uploaded
    // for, and it went public without ever being held — which is what tells it
    // apart from a key whose only reference the claimant created below.
    vi.stubEnv("NSFW_MODE", "local");
    verdictFindUnique.mockResolvedValue(null);
    puzzleFindMany.mockResolvedValue([{ ownerId: "owner-1", isPublic: true }]);

    await callPost({ ...BODY, isPublic: true });

    expect(txCreate.mock.calls[0][0].data.isPublic).toBe(true);
    expect(txReportCreate).not.toHaveBeenCalled();
  });

  it("holds a key with no verdict that no puzzle references", async () => {
    // Nothing deletes the stored object when its verdict goes, so "no verdict"
    // on an unclaimed key means the row was swept as an orphan or its write
    // failed — not that the image is old and clean. Publishing it would let a
    // flagged upload be laundered by simply waiting out the sweep.
    vi.stubEnv("NSFW_MODE", "local");
    verdictFindUnique.mockResolvedValue(null);
    puzzleFindMany.mockResolvedValue([]);

    const res = await callPost({ ...BODY, isPublic: true });

    expect(txCreate.mock.calls[0][0].data.isPublic).toBe(false);
    expect(txReportCreate).toHaveBeenCalled();
    await expect(res.json()).resolves.toEqual({ id: "p1", pendingReview: true });
  });

  it("holds a key with no verdict whose only puzzles are private", async () => {
    // A private reference proves nothing, because the claimant can create it:
    // the first claim of a swept key is held, and that held puzzle then
    // references the key. If any reference counted, a second POST with the same
    // key would publish the image with no report at all (see
    // app/api/puzzles/laundering.test.ts for the full sequence). Only a public
    // reference earns the carve-out, and a held puzzle can never become one —
    // create forces `isPublic && !pendingReview`, and PATCH to public answers
    // 409 while the AUTO_NSFW report is open.
    //
    // The accepted cost: a pre-feature image whose only puzzle is private is
    // held when its key is claimed again. A false positive in the safe
    // direction, one admin glance to clear — do not "fix" this back.
    vi.stubEnv("NSFW_MODE", "local");
    verdictFindUnique.mockResolvedValue(null);
    puzzleFindMany.mockResolvedValue([
      { ownerId: "owner-1", isPublic: false },
      { ownerId: "owner-1", isPublic: false },
    ]);

    const res = await callPost({ ...BODY, isPublic: true });

    expect(txCreate.mock.calls[0][0].data.isPublic).toBe(false);
    expect(txReportCreate).toHaveBeenCalled();
    await expect(res.json()).resolves.toEqual({ id: "p1", pendingReview: true });
  });

  it("names the missing row in the report, not a model that never ran", async () => {
    vi.stubEnv("NSFW_MODE", "local");
    verdictFindUnique.mockResolvedValue(null);

    await callPost({ ...BODY, isPublic: true });

    const { message } = txReportCreate.mock.calls[0][0].data;
    expect(message).toContain("UNKNOWN");
    expect(message).toContain("unknown");
  });

  it("holds an unclaimed key with no verdict when external classification is misconfigured", async () => {
    // The composition the two rules either side of this one used to miss.
    // `external` without credentials is degraded to `unavailable`, not to
    // `off`, precisely so this carve-out stays shut: an instance that lost its
    // API key would otherwise both score every upload CLEAN *and* publish
    // every key whose verdict the sweep already took.
    vi.stubEnv("NSFW_MODE", "external"); // no NSFW_API_URL, no NSFW_API_KEY
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    verdictFindUnique.mockResolvedValue(null);
    puzzleFindMany.mockResolvedValue([]);

    const res = await callPost({ ...BODY, isPublic: true });

    expect(txCreate.mock.calls[0][0].data.isPublic).toBe(false);
    expect(txReportCreate).toHaveBeenCalled();
    await expect(res.json()).resolves.toEqual({ id: "p1", pendingReview: true });
    warned.mockRestore();
  });

  it("tells the admins about a machine hold", async () => {
    // The uploader is told to wait for a review; somebody has to be told to
    // perform one. A user report has emailed every admin since #22, and this
    // path notified nobody — the asymmetry was backwards, because this is the
    // case where the content is most likely to actually be bad and the only one
    // where a user is blocked until an admin acts.
    vi.stubEnv("NSFW_MODE", "local");
    verdictFindUnique.mockResolvedValue({ label: "FLAGGED", score: 0.97, model: "local:x" });

    await callPost({ ...BODY, isPublic: true });

    expect(notifyAdmins).toHaveBeenCalledWith("My puzzle", "AUTO_NSFW", "machine");
  });

  it("does not notify anyone about a clean upload", async () => {
    verdictFindUnique.mockResolvedValue({ label: "CLEAN", score: 0.01, model: "local:x" });

    await callPost({ ...BODY, isPublic: true });

    expect(notifyAdmins).not.toHaveBeenCalled();
  });

  it("does not notify when the puzzle was never committed", async () => {
    // Proves the notification sits after the transaction rather than inside it:
    // no puzzle, no report, so nothing to review. Mail inside the transaction
    // would also hold it open across an SMTP round trip.
    vi.stubEnv("NSFW_MODE", "local");
    verdictFindUnique.mockResolvedValue({ label: "FLAGGED", score: 0.97, model: "local:x" });
    transaction.mockRejectedValue(new Error("db down"));

    await expect(callPost({ ...BODY, isPublic: true })).rejects.toThrow("db down");

    expect(notifyAdmins).not.toHaveBeenCalled();
  });

  it("keeps publishing an unclaimed key with no verdict when classification is off", async () => {
    // Nothing is judged in `off` mode, so holding here would hold every
    // upload on an instance that deliberately runs without a classifier.
    vi.stubEnv("NSFW_MODE", "off");
    verdictFindUnique.mockResolvedValue(null);
    puzzleFindMany.mockResolvedValue([]);

    await callPost({ ...BODY, isPublic: true });

    expect(txCreate.mock.calls[0][0].data.isPublic).toBe(true);
    expect(txReportCreate).not.toHaveBeenCalled();
  });

  it("still reads a stored verdict in off mode rather than assuming clean", async () => {
    // An instance that switches the classifier off must not republish what it
    // flagged while it was on.
    vi.stubEnv("NSFW_MODE", "off");
    verdictFindUnique.mockResolvedValue({ label: "FLAGGED", score: 0.97, model: "local:x" });

    await callPost({ ...BODY, isPublic: true });

    expect(txCreate.mock.calls[0][0].data.isPublic).toBe(false);
    expect(txReportCreate).toHaveBeenCalled();
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
