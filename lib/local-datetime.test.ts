import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fromLocalInput, toLocalInput } from "./local-datetime";

describe("datetime-local conversion", () => {
  beforeEach(() => vi.stubEnv("TZ", "Europe/Berlin"));
  afterEach(() => vi.unstubAllEnvs());

  it("reads the input in the local timezone", () => {
    // CEST is UTC+2.
    expect(fromLocalInput("2026-10-01T10:00")).toBe("2026-10-01T08:00:00.000Z");
  });

  it("round-trips", () => {
    expect(toLocalInput(fromLocalInput("2026-12-24T18:30"))).toBe("2026-12-24T18:30");
  });

  it.each(["", "tomorrow", "2026-10-01", "2026-10-01T10:00:00Z"])("reads %j as no date", (v) => {
    expect(fromLocalInput(v)).toBeNull();
  });

  it("shows nothing for no date or a broken one", () => {
    expect(toLocalInput(null)).toBe("");
    expect(toLocalInput("nope")).toBe("");
  });
});
