import { describe, expect, it, vi } from "vitest";
import { anonymizeReportsBy, resolveOpenReports } from "./reports-server";

function db(count = 1) {
  return { report: { updateMany: vi.fn().mockResolvedValue({ count }) } };
}

function readerDb(rows: { id: string; reporterEmail: string | null }[]) {
  return {
    report: {
      findMany: vi.fn().mockResolvedValue(rows),
      updateMany: vi.fn().mockImplementation((args: { where: { id: { in: string[] } } }) =>
        Promise.resolve({ count: args.where.id.in.length }),
      ),
    },
  };
}

describe("resolveOpenReports", () => {
  it("stamps the decision and drops the reporter's contact and IP hash", () => {
    // Resolved implies anonymized: reporter PII is only needed while a report
    // is open. A resolver that forgets one of the two null fields retains it
    // silently, which is why every caller goes through here.
    const client = db();
    resolveOpenReports(client, { id: "r1" }, "DISMISSED");
    expect(client.report.updateMany).toHaveBeenCalledWith({
      where: { id: "r1", status: "OPEN" },
      data: {
        status: "DISMISSED",
        resolvedAt: expect.any(Date),
        reporterEmail: null,
        reporterIpHash: null,
      },
    });
  });

  it("scopes the update to OPEN reports so anonymization happens exactly once", () => {
    const client = db();
    resolveOpenReports(client, { puzzleId: "p1" }, "TAKEDOWN");
    expect(client.report.updateMany.mock.calls[0][0].where).toEqual({
      puzzleId: "p1",
      status: "OPEN",
    });
  });

  it("reports how many reports it resolved so a caller can answer 404 on none", async () => {
    expect(await resolveOpenReports(db(0), { id: "r1" }, "DISMISSED")).toBe(0);
    expect(await resolveOpenReports(db(3), { puzzleId: "p1" }, "TAKEDOWN")).toBe(3);
  });
});

describe("anonymizeReportsBy", () => {
  it("drops the contact from the reports that address filed", async () => {
    const client = readerDb([
      { id: "r1", reporterEmail: "gone@example.com" },
      { id: "r2", reporterEmail: "other@example.com" },
    ]);

    expect(await anonymizeReportsBy(client, "gone@example.com")).toBe(1);
    expect(client.report.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["r1"] } },
      data: { reporterEmail: null, reporterIpHash: null },
    });
  });

  it("matches regardless of case and surrounding space", async () => {
    // reporterEmail is stored exactly as typed; User.email is normalized. An
    // exact-match filter would miss the reports and silently retain the PII.
    const client = readerDb([{ id: "r1", reporterEmail: "  Gone@Example.COM " }]);

    expect(await anonymizeReportsBy(client, "gone@example.com")).toBe(1);
    expect(client.report.updateMany.mock.calls[0][0].where).toEqual({ id: { in: ["r1"] } });
  });

  it("leaves the status alone so an open report stays in the queue", async () => {
    // These reports are about other people's content, which is not going
    // anywhere — closing them would erase somebody else's pending case.
    const client = readerDb([{ id: "r1", reporterEmail: "gone@example.com" }]);

    await anonymizeReportsBy(client, "gone@example.com");

    const { data } = client.report.updateMany.mock.calls[0][0];
    expect(data).not.toHaveProperty("status");
    expect(data).not.toHaveProperty("resolvedAt");
  });

  it("writes nothing when the address filed no report", async () => {
    const client = readerDb([{ id: "r1", reporterEmail: "other@example.com" }]);
    expect(await anonymizeReportsBy(client, "gone@example.com")).toBe(0);
    expect(client.report.updateMany).not.toHaveBeenCalled();
  });

  it("only considers rows that still carry an address", async () => {
    const client = readerDb([]);
    await anonymizeReportsBy(client, "gone@example.com");
    expect(client.report.findMany.mock.calls[0][0].where).toEqual({
      reporterEmail: { not: null },
    });
  });
});
