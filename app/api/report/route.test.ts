import { beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("@/lib/mail", () => ({ sendReportNotification: sendReportNotificationMock }));
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
  puzzleFindUnique.mockResolvedValue({ title: "Beach", isPublic: true });
  reportCount.mockResolvedValue(0);
  reportFindFirst.mockResolvedValue(null);
  reportCreate.mockResolvedValue({ id: "r1" });
  userFindMany.mockResolvedValue([{ email: "admin@example.com" }]);
  sendReportNotificationMock.mockResolvedValue(undefined);
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
    expect(sendReportNotificationMock).toHaveBeenCalledWith("admin@example.com", "Beach", "NSFW");
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

  it("answers a silent 200 without a new row for a duplicate open report", async () => {
    reportFindFirst.mockResolvedValue({ id: "r0" });
    const res = await callPost(VALID);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(reportCreate).not.toHaveBeenCalled();
    expect(sendReportNotificationMock).not.toHaveBeenCalled();
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
