import { describe, expect, it } from "vitest";
import {
  isReportCategory,
  isReportStatus,
  REPORT_CATEGORIES,
  REPORT_STATUSES,
} from "./reports";

describe("report enums", () => {
  it("defines the four categories and four statuses", () => {
    expect(REPORT_CATEGORIES).toEqual(["NSFW", "ILLEGAL", "COPYRIGHT", "OTHER"]);
    // ACCOUNT_DELETED is not an admin decision: it records that the reported
    // puzzle left with its owner's account, unreviewed.
    expect(REPORT_STATUSES).toEqual(["OPEN", "TAKEDOWN", "DISMISSED", "ACCOUNT_DELETED"]);
  });
});

describe("isReportCategory", () => {
  it("accepts every canonical category", () => {
    for (const c of REPORT_CATEGORIES) {
      expect(isReportCategory(c)).toBe(true);
    }
  });

  it("rejects unknown DB values instead of letting them reach translation lookups", () => {
    expect(isReportCategory("SPAM")).toBe(false);
    expect(isReportCategory("nsfw")).toBe(false);
    expect(isReportCategory("")).toBe(false);
  });
});

describe("isReportStatus", () => {
  it("accepts every canonical status", () => {
    for (const s of REPORT_STATUSES) {
      expect(isReportStatus(s)).toBe(true);
    }
  });

  it("rejects unknown DB values", () => {
    expect(isReportStatus("RESOLVED")).toBe(false);
    expect(isReportStatus("open")).toBe(false);
    expect(isReportStatus("")).toBe(false);
  });
});
