import { beforeEach, describe, expect, it, vi } from "vitest";

const { userFindMany, sendReport, sendAutoReport } = vi.hoisted(() => ({
  userFindMany: vi.fn(),
  sendReport: vi.fn(),
  sendAutoReport: vi.fn(),
}));

vi.mock("./db", () => ({ prisma: { user: { findMany: userFindMany } } }));
vi.mock("./mail", () => ({
  sendReportNotification: sendReport,
  sendAutoReportNotification: sendAutoReport,
}));

import { notifyAdminsOfReport } from "./report-notify";

beforeEach(() => {
  vi.clearAllMocks();
  userFindMany.mockResolvedValue([
    { email: "a@example.com", locale: "en" },
    { email: "b@example.com", locale: "it" },
  ]);
  sendReport.mockResolvedValue(undefined);
  sendAutoReport.mockResolvedValue(undefined);
});

describe("notifyAdminsOfReport", () => {
  it("pings every admin, not just the first", async () => {
    await notifyAdminsOfReport("Beach", "NSFW", "user");

    expect(sendReport).toHaveBeenCalledTimes(2);
    expect(sendReport).toHaveBeenCalledWith("a@example.com", "Beach", "NSFW", "en");
    expect(sendReport).toHaveBeenCalledWith("b@example.com", "Beach", "NSFW", "it");
  });

  it("mails each admin in their own language, not the reporter's", async () => {
    // The whole point of the column: the two admins here browse in different
    // languages, and neither is the person who filed the report.
    await notifyAdminsOfReport("Beach", "NSFW", "user");

    expect(sendReport.mock.calls.map((c) => c.at(-1))).toEqual(["en", "it"]);
  });

  it("sends the machine wording for a machine finding", async () => {
    // The asymmetry this helper exists to remove: the classifier's own finding
    // used to notify nobody at all, in the one case where a user is blocked
    // waiting for the review it asks for.
    await notifyAdminsOfReport("Beach", "AUTO_NSFW", "machine");

    expect(sendAutoReport).toHaveBeenCalledTimes(2);
    expect(sendAutoReport).toHaveBeenCalledWith("a@example.com", "Beach", "AUTO_NSFW", "en");
    expect(sendReport).not.toHaveBeenCalled();
  });

  it("says so when there is no admin to notify", async () => {
    // Otherwise the no-admins case is indistinguishable from success and
    // reports queue up unseen indefinitely.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    userFindMany.mockResolvedValue([]);

    await notifyAdminsOfReport("Beach", "AUTO_NSFW", "machine");

    expect(logged).toHaveBeenCalledWith(expect.stringContaining("no ADMIN users to notify"));
    expect(sendAutoReport).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it("logs one failed recipient and still mails the others", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    sendReport.mockRejectedValueOnce(new Error("mailbox full"));

    await expect(notifyAdminsOfReport("Beach", "NSFW", "user")).resolves.toBeUndefined();

    expect(sendReport).toHaveBeenCalledTimes(2);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("never throws, even when the admin lookup itself fails", async () => {
    // This runs after the report row is committed. Throwing would turn a report
    // that landed — or a puzzle that was created and correctly held — into a
    // 500 for something the caller can do nothing about.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    userFindMany.mockRejectedValue(new Error("db down"));

    await expect(notifyAdminsOfReport("Beach", "AUTO_NSFW", "machine")).resolves.toBeUndefined();

    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("tags the log with the origin, so an operator can tell the two apart", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    userFindMany.mockResolvedValue([]);

    await notifyAdminsOfReport("Beach", "NSFW", "user");
    await notifyAdminsOfReport("Beach", "AUTO_NSFW", "machine");

    expect(logged.mock.calls[0][0]).toContain("[report]");
    expect(logged.mock.calls[1][0]).toContain("[nsfw]");
    logged.mockRestore();
  });
});
