import { describe, expect, it } from "vitest";
import {
  isReportCategory,
  REPORT_CATEGORIES,
  REPORT_STATUSES,
} from "./reports";

describe("report enums", () => {
  it("defines the four categories and three statuses", () => {
    expect(REPORT_CATEGORIES).toEqual(["NSFW", "ILLEGAL", "COPYRIGHT", "OTHER"]);
    expect(REPORT_STATUSES).toEqual(["OPEN", "TAKEDOWN", "DISMISSED"]);
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
