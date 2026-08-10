import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { readNsfwConfig } from "./config";

describe("readNsfwConfig", () => {
  it("is off when nothing is set, so an existing instance is unchanged", () => {
    expect(readNsfwConfig({}).mode).toBe("off");
  });

  it("stays off for an operator who never asked for classification", () => {
    // The distinction that makes `unavailable` below safe: unset, empty and an
    // explicit `off` are all "no classifier wanted", and must never hold an
    // upload. An empty value is worth pinning because `NSFW_MODE=` is how a
    // compose file usually says "leave this alone".
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(readNsfwConfig({ NSFW_MODE: "off" }).mode).toBe("off");
    expect(readNsfwConfig({ NSFW_MODE: "" }).mode).toBe("off");
    expect(readNsfwConfig({ NSFW_MODE: "   " }).mode).toBe("off");
    expect(warned).not.toHaveBeenCalled();
    warned.mockRestore();
  });

  it("carries the defaults for threshold and timeout", () => {
    const config = readNsfwConfig({});
    expect(config.threshold).toBe(0.85);
    expect(config.timeoutMs).toBe(5000);
  });

  it("reads an explicit mode", () => {
    expect(readNsfwConfig({ NSFW_MODE: "local" }).mode).toBe("local");
  });

  it("becomes unavailable, not off, on a mode it does not know", () => {
    // `NSFW_MODE=locel` is an operator who asked for classification and would
    // silently not get it. Falling back to `off` is the one fail-open path in
    // this feature, and it opens two holes at once: every upload scores CLEAN,
    // and app/api/puzzles/route.ts reads a *missing* verdict as clean too.
    // Uploading still works — `unavailable` holds images for review rather
    // than rejecting them — so an optional feature still cannot break a POST.
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(readNsfwConfig({ NSFW_MODE: "locel" }).mode).toBe("unavailable");
    expect(warned).toHaveBeenCalled();
    warned.mockRestore();
  });

  it("becomes unavailable, not off, when external has no url or key", () => {
    // The likelier half of the same bug: a rotated secret or an unmounted
    // variable on an instance that has classification deliberately switched
    // on. `local` has no equivalent — a missing model fails inside classify(),
    // where the guard already turns it into UNKNOWN.
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(readNsfwConfig({ NSFW_MODE: "external" }).mode).toBe("unavailable");
    expect(
      readNsfwConfig({ NSFW_MODE: "external", NSFW_API_URL: "https://x.example" }).mode,
    ).toBe("unavailable");
    expect(warned).toHaveBeenCalled();
    warned.mockRestore();
  });

  it("keeps external when both credentials are present", () => {
    const config = readNsfwConfig({
      NSFW_MODE: "external",
      NSFW_API_URL: "https://x.example/check",
      NSFW_API_KEY: "secret",
      LEGAL_CLASSIFIER_PROCESSOR: "Example Classifier Inc.",
    });
    expect(config.mode).toBe("external");
    expect(config.apiUrl).toBe("https://x.example/check");
  });

  it("warns, but keeps classifying, when external has no named legal processor", () => {
    // A missing LEGAL_CLASSIFIER_PROCESSOR is a disclosure gap, not a reason
    // to stop uploads from being classified — unlike the missing url/key case
    // above, which makes the classifier unusable outright.
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = readNsfwConfig({
      NSFW_MODE: "external",
      NSFW_API_URL: "https://x.example/check",
      NSFW_API_KEY: "secret",
    });
    expect(config.mode).toBe("external");
    expect(warned).toHaveBeenCalled();
    warned.mockRestore();
  });

  it("does not warn about the legal processor once one is named", () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    readNsfwConfig({
      NSFW_MODE: "external",
      NSFW_API_URL: "https://x.example/check",
      NSFW_API_KEY: "secret",
      LEGAL_CLASSIFIER_PROCESSOR: "Example Classifier Inc.",
    });
    expect(warned).not.toHaveBeenCalled();
    warned.mockRestore();
  });

  it("does not warn about the legal processor in local or off mode", () => {
    // The variable only matters once images actually leave the instance.
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    readNsfwConfig({ NSFW_MODE: "local" });
    readNsfwConfig({});
    expect(warned).not.toHaveBeenCalled();
    warned.mockRestore();
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

// Reading the variables correctly is worth nothing if the deployment never
// passes them in. Both compose files list env explicitly, so a literal value
// there silently overrides whatever the operator put in .env — which is how
// NSFW_MODEL_PATH came to be documented as overridable in .env.example while
// being impossible to override in either stack. Scanned rather than enumerated,
// so a future NSFW_* variable added as a literal is caught too.
describe("the compose files pass every NSFW_* variable through", () => {
  it.each(["docker-compose.yml", "docker-compose.sqlite.yml"])("%s", (file) => {
    const literals = readFileSync(file, "utf8")
      .split("\n")
      .map((line) => line.match(/^\s+(NSFW_[A-Z_]+):\s*(.+?)\s*$/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .filter(([, , value]) => !value.includes("${"))
      .map(([, key]) => key);

    expect(literals).toEqual([]);
  });

  it("passes through every variable readNsfwConfig and local.ts actually read", () => {
    // The other direction: a variable the code reads but compose never mentions
    // is just as invisible to an operator as a hardcoded one.
    const compose = readFileSync("docker-compose.yml", "utf8");
    for (const key of [
      "NSFW_MODE",
      "NSFW_THRESHOLD",
      "NSFW_TIMEOUT_MS",
      "NSFW_API_URL",
      "NSFW_API_KEY",
      "NSFW_MODEL_PATH",
    ]) {
      expect(compose, `${key} missing from docker-compose.yml`).toContain(`${key}:`);
    }
  });
});
