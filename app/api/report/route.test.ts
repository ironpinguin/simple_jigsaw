import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REPORT_RATE_WINDOW_MS } from "@/lib/reports";

const {
  puzzleFindUnique,
  reportCount,
  reportFindFirst,
  reportCreate,
  userFindMany,
  sendReportNotificationMock,
} = vi.hoisted(() => ({
  puzzleFindUnique: vi.fn(),
  reportCount: vi.fn(),
  reportFindFirst: vi.fn(),
  reportCreate: vi.fn(),
  userFindMany: vi.fn(),
  sendReportNotificationMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    puzzle: { findUnique: puzzleFindUnique },
    report: { count: reportCount, findFirst: reportFindFirst, create: reportCreate },
    user: { findMany: userFindMany },
  },
}));
// Both, because the route now notifies through lib/report-notify, which picks
// the wording from the report's origin. A user report must still take the
// sendReportNotification branch — that is what the assertions below pin.
vi.mock("@/lib/mail", () => ({
  sendReportNotification: sendReportNotificationMock,
  sendAutoReportNotification: vi.fn(),
}));
vi.mock("@/lib/i18n-server", () => ({
  getErrorT: async () => (key: string) => key,
}));

import { POST } from "./route";

function callPost(body: unknown, forwardedFor = "203.0.113.7") {
  return POST(
    new Request("http://test/api/report", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": forwardedFor,
      },
      body: JSON.stringify(body),
    }),
  );
}

const VALID = {
  puzzleId: "p1",
  category: "NSFW",
  message: "This image is sexually explicit.",
};

beforeEach(() => {
  vi.clearAllMocks();
  // hashReporterIp runs unmocked: it throws without AUTH_SECRET, and only a
  // trusted-proxy deployment derives per-IP buckets from x-forwarded-for.
  vi.stubEnv("AUTH_SECRET", "test-secret");
  vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
  puzzleFindUnique.mockResolvedValue({ title: "Beach", isPublic: true });
  reportCount.mockResolvedValue(0);
  reportFindFirst.mockResolvedValue(null);
  reportCreate.mockResolvedValue({ id: "r1" });
  userFindMany.mockResolvedValue([{ email: "admin@example.com", locale: "en" }]);
  sendReportNotificationMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/report", () => {
  it("creates a report and notifies the admins", async () => {
    const res = await callPost(VALID);
    expect(res.status).toBe(200);
    expect(reportCreate).toHaveBeenCalledTimes(1);
    expect(reportCreate.mock.calls[0][0].data).toMatchObject({
      puzzleId: "p1",
      puzzleTitle: "Beach",
      category: "NSFW",
      message: VALID.message,
      reporterEmail: null,
    });
    // "en", not the reporter's locale: the admin is not who filed this.
    expect(sendReportNotificationMock).toHaveBeenCalledWith(
      "admin@example.com",
      "Beach",
      "NSFW",
      "en",
    );
  });

  it("stores only a hash of the IP, never the plain address", async () => {
    await callPost(VALID, "203.0.113.7");
    const data = reportCreate.mock.calls[0][0].data;
    expect(data.reporterIpHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(data)).not.toContain("203.0.113.7");
  });

  it("answers 404 for an unknown puzzle", async () => {
    puzzleFindUnique.mockResolvedValue(null);
    const res = await callPost(VALID);
    expect(res.status).toBe(404);
    expect(reportCreate).not.toHaveBeenCalled();
  });

  it("answers 404 for a private puzzle — indistinguishable from unknown", async () => {
    puzzleFindUnique.mockResolvedValue({ title: "Secret", isPublic: false });
    const res = await callPost(VALID);
    expect(res.status).toBe(404);
    expect(reportCreate).not.toHaveBeenCalled();
  });

  it("rejects a too-short message and an unknown category", async () => {
    expect((await callPost({ ...VALID, message: "short" })).status).toBe(400);
    expect((await callPost({ ...VALID, category: "SPAM" })).status).toBe(400);
    expect(reportCreate).not.toHaveBeenCalled();
  });

  it("rejects machine-generated categories that a user cannot pick", async () => {
    // AUTO_NSFW is valid in the database but users cannot submit it — the
    // server writes it directly when it detects NSFW content. Accepting it
    // from the API would let an attacker forge a machine verdict.
    const res = await callPost({ ...VALID, category: "AUTO_NSFW" });
    expect(res.status).toBe(400);
    expect(reportCreate).not.toHaveBeenCalled();
  });

  it("stores the reporter email when given and rejects an invalid one", async () => {
    await callPost({ ...VALID, email: "me@example.com" });
    expect(reportCreate.mock.calls[0][0].data.reporterEmail).toBe("me@example.com");
    expect((await callPost({ ...VALID, email: "not-an-email" })).status).toBe(400);
  });

  it("answers 429 once the hourly limit for the IP hash is reached", async () => {
    reportCount.mockResolvedValue(5);
    const res = await callPost(VALID);
    expect(res.status).toBe(429);
    expect(reportCreate).not.toHaveBeenCalled();
  });

  it("counts only this reporter's recent reports towards the limit", async () => {
    // The filters carry the abuse-control semantics: dropping the hash would
    // rate-limit the whole site collectively, dropping the window would turn
    // the hourly limit into a lifetime ban.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T12:00:00.000Z"));
    try {
      await callPost(VALID);
      expect(reportCount).toHaveBeenCalledWith({
        where: {
          reporterIpHash: expect.stringMatching(/^[0-9a-f]{64}$/),
          createdAt: { gte: new Date(Date.now() - REPORT_RATE_WINDOW_MS) },
        },
      });
      // Same bucket that the created report is filed under.
      expect(reportCount.mock.calls[0][0].where.reporterIpHash).toBe(
        reportCreate.mock.calls[0][0].data.reporterIpHash,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("scopes the dedup check to this puzzle, this reporter and OPEN reports", async () => {
    // status: "OPEN" is what lets a puzzle whose report was dismissed be
    // reported again by the same IP.
    await callPost(VALID);
    expect(reportFindFirst).toHaveBeenCalledWith({
      where: {
        puzzleId: "p1",
        reporterIpHash: reportCreate.mock.calls[0][0].data.reporterIpHash,
        status: "OPEN",
      },
      select: { id: true },
    });
  });

  it("skips dedup entirely when no trusted proxy is configured — a shared bucket must not silence reports", async () => {
    // With TRUSTED_PROXY_HOPS=0 every visitor hashes to the same bucket. If
    // dedup ran on that constant, the first report of a puzzle (e.g. an
    // uploader's innocuous self-report) would silently swallow every later
    // report from anyone, site-wide.
    vi.stubEnv("TRUSTED_PROXY_HOPS", "0");
    reportFindFirst.mockResolvedValue({ id: "r0" });
    const res = await callPost(VALID);
    expect(res.status).toBe(200);
    expect(reportFindFirst).not.toHaveBeenCalled();
    expect(reportCreate).toHaveBeenCalledTimes(1);
    expect(sendReportNotificationMock).toHaveBeenCalledTimes(1);
  });

  it("still enforces the (collective) rate limit when no trusted proxy is configured", async () => {
    // Skipping dedup must not also skip the limiter, or the default config
    // would accept unlimited report spam.
    vi.stubEnv("TRUSTED_PROXY_HOPS", "0");
    reportCount.mockResolvedValue(5);
    const res = await callPost(VALID);
    expect(res.status).toBe(429);
    expect(reportCreate).not.toHaveBeenCalled();
  });

  it("answers a silent 200 without a new row for a duplicate open report", async () => {
    reportFindFirst.mockResolvedValue({ id: "r0" });
    const res = await callPost(VALID);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(reportCreate).not.toHaveBeenCalled();
    expect(sendReportNotificationMock).not.toHaveBeenCalled();
  });

  it("logs an error when no admin exists to notify — the report would otherwise sit unseen", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    userFindMany.mockResolvedValue([]);
    const res = await callPost(VALID);
    expect(res.status).toBe(200);
    expect(reportCreate).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("no ADMIN"));
    errorSpy.mockRestore();
  });

  it("still answers 200 when the admin mail fails, but logs it", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    sendReportNotificationMock.mockRejectedValue(new Error("smtp down"));
    const res = await callPost(VALID);
    expect(res.status).toBe(200);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
