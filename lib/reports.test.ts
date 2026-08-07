import { describe, expect, it } from "vitest";
import { hashReporterIp, REPORT_CATEGORIES, REPORT_STATUSES } from "./reports";

describe("report enums", () => {
  it("defines the four categories and three statuses", () => {
    expect(REPORT_CATEGORIES).toEqual(["NSFW", "ILLEGAL", "COPYRIGHT", "OTHER"]);
    expect(REPORT_STATUSES).toEqual(["OPEN", "TAKEDOWN", "DISMISSED"]);
  });
});

describe("hashReporterIp", () => {
  it("is deterministic for the same address", () => {
    expect(hashReporterIp("203.0.113.7")).toBe(hashReporterIp("203.0.113.7"));
  });

  it("differs between addresses", () => {
    expect(hashReporterIp("203.0.113.7")).not.toBe(hashReporterIp("203.0.113.8"));
  });

  it("returns hex that does not contain the plain address", () => {
    const hash = hashReporterIp("203.0.113.7");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain("203.0.113.7");
  });

  it("uses only the first x-forwarded-for entry", () => {
    expect(hashReporterIp("203.0.113.7, 10.0.0.1")).toBe(hashReporterIp("203.0.113.7"));
  });

  it("falls back to a stable bucket when the header is missing", () => {
    expect(hashReporterIp(null)).toBe(hashReporterIp(""));
  });
});
