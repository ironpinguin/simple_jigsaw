import { describe, expect, it, vi } from "vitest";
import { readNsfwConfig } from "./config";

describe("readNsfwConfig", () => {
  it("is off when nothing is set, so an existing instance is unchanged", () => {
    expect(readNsfwConfig({}).mode).toBe("off");
  });

  it("carries the defaults for threshold and timeout", () => {
    const config = readNsfwConfig({});
    expect(config.threshold).toBe(0.85);
    expect(config.timeoutMs).toBe(5000);
  });

  it("reads an explicit mode", () => {
    expect(readNsfwConfig({ NSFW_MODE: "local" }).mode).toBe("local");
  });

  it("falls back to off and warns on a mode it does not know", () => {
    // A typo must not break uploading for a feature that is optional.
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(readNsfwConfig({ NSFW_MODE: "locel" }).mode).toBe("off");
    expect(warned).toHaveBeenCalled();
    warned.mockRestore();
  });

  it("falls back to off and warns when external has no url or key", () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(readNsfwConfig({ NSFW_MODE: "external" }).mode).toBe("off");
    expect(
      readNsfwConfig({ NSFW_MODE: "external", NSFW_API_URL: "https://x.example" }).mode,
    ).toBe("off");
    expect(warned).toHaveBeenCalled();
    warned.mockRestore();
  });

  it("keeps external when both credentials are present", () => {
    const config = readNsfwConfig({
      NSFW_MODE: "external",
      NSFW_API_URL: "https://x.example/check",
      NSFW_API_KEY: "secret",
    });
    expect(config.mode).toBe("external");
    expect(config.apiUrl).toBe("https://x.example/check");
  });

  it("ignores an unusable threshold rather than classifying everything", () => {
    // NSFW_THRESHOLD=0 would flag every upload; a non-number would make the
    // comparison always false and flag nothing. Both fall back to the default.
    expect(readNsfwConfig({ NSFW_THRESHOLD: "banana" }).threshold).toBe(0.85);
    expect(readNsfwConfig({ NSFW_THRESHOLD: "0" }).threshold).toBe(0.85);
    expect(readNsfwConfig({ NSFW_THRESHOLD: "1.5" }).threshold).toBe(0.85);
    expect(readNsfwConfig({ NSFW_THRESHOLD: "0.6" }).threshold).toBe(0.6);
  });
});
