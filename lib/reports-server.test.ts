import { describe, expect, it, vi } from "vitest";
import { resolveOpenReports } from "./reports-server";

function db(count = 1) {
  return { report: { updateMany: vi.fn().mockResolvedValue({ count }) } };
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
