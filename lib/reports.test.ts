import { describe, expect, it } from "vitest";
import {
  AUTO_REPORT_CATEGORIES,
  categoriesFor,
  isReportCategory,
  isReportStatus,
  REPORT_CATEGORIES,
  REPORT_STATUSES,
} from "./reports";

describe("report enums", () => {
  it("defines the five categories and four statuses", () => {
    expect(REPORT_CATEGORIES).toEqual(["NSFW", "ILLEGAL", "COPYRIGHT", "NAME", "OTHER"]);
    // ACCOUNT_DELETED is not an admin decision: it records that the reported
    // puzzle left with its owner's account, unreviewed.
    expect(REPORT_STATUSES).toEqual(["OPEN", "TAKEDOWN", "DISMISSED", "ACCOUNT_DELETED"]);
  });

  it("offers the leaderboard-name category only with a leaderboard", () => {
    expect(categoriesFor(false)).not.toContain("NAME");
    expect(categoriesFor(true)).toEqual(REPORT_CATEGORIES);
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

describe("machine-generated categories", () => {
  it("keeps AUTO_NSFW out of what a user can pick", () => {
    // ReportDialog renders one radio per REPORT_CATEGORIES entry; a machine
    // verdict is not something a person reports.
    expect(REPORT_CATEGORIES).not.toContain("AUTO_NSFW");
  });

  it("accepts AUTO_NSFW when reading a row back", () => {
    // The admin queue narrows every stored category before translating it.
    expect(isReportCategory("AUTO_NSFW")).toBe(true);
  });

  it("still accepts the user categories and rejects nonsense", () => {
    expect(isReportCategory("NSFW")).toBe(true);
    expect(isReportCategory("SOMETHING_ELSE")).toBe(false);
  });

  it("names exactly one machine category", () => {
    expect(AUTO_REPORT_CATEGORIES).toEqual(["AUTO_NSFW"]);
  });
});
