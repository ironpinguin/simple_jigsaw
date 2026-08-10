import { afterEach, describe, expect, it, vi } from "vitest";
import { createExternalClassifier } from "./external";
import { getClassifier, resetClassifierForTests } from "./index";
import { createLocalClassifier } from "./local";
import type { Classifier } from "./types";

// Fakes stand in for the real factories so a valid `local`/`external` config
// can be routed through `getClassifier` without loading a model or making a
// request: what's under test here is the routing decision and the guard
// wrapping, not either mode's own behaviour (that's local.test.ts and
// external.test.ts).
vi.mock("./local", () => ({
  createLocalClassifier: vi.fn(
    (): Classifier => ({
      classify: vi.fn().mockResolvedValue({ label: "CLEAN", score: 0, model: "fake-local" }),
    }),
  ),
}));
vi.mock("./external", () => ({
  createExternalClassifier: vi.fn(
    (): Classifier => ({
      classify: vi.fn().mockResolvedValue({ label: "CLEAN", score: 0, model: "fake-external" }),
    }),
  ),
}));

const localFactory = vi.mocked(createLocalClassifier);
const externalFactory = vi.mocked(createExternalClassifier);

afterEach(() => {
  resetClassifierForTests();
  vi.unstubAllEnvs();
  localFactory.mockClear();
  externalFactory.mockClear();
});

describe("getClassifier", () => {
  it("hands back the off classifier when nothing is configured", async () => {
    const verdict = await getClassifier().classify(Buffer.from("x"));

    expect(verdict).toEqual({ label: "CLEAN", score: 0, model: "off" });
  });

  it("builds the classifier once per process", () => {
    // Otherwise every upload rebuilds it — and in local mode reloads the model.
    expect(getClassifier()).toBe(getClassifier());
  });

  it("holds every image when classification is configured but unusable", async () => {
    // Not the off classifier: an instance that asked for `external` and lost
    // its credentials must not go on publishing everything as CLEAN. Neither
    // factory is called — there is nothing to build — but the verdict is
    // UNKNOWN, so requiresReview holds the puzzle exactly as a real failure
    // would. `model` says which, so the moderation queue is readable.
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("NSFW_MODE", "external");   // no url, no key

    const verdict = await getClassifier().classify(Buffer.from("x"));

    expect(verdict).toEqual({ label: "UNKNOWN", score: 0, model: "unavailable" });
    expect(localFactory).not.toHaveBeenCalled();
    expect(externalFactory).not.toHaveBeenCalled();
    expect(warned).toHaveBeenCalled();
    warned.mockRestore();
  });

  it("routes a valid local config to createLocalClassifier", async () => {
    vi.stubEnv("NSFW_MODE", "local");
    // Deliberately not the defaults: asserting the parsed values reach the
    // factory is what stops the operator's knobs being quietly disconnected
    // from the classifier. config.test.ts proves NSFW_THRESHOLD parses and
    // local.test.ts proves the classifier honours whatever it is handed —
    // this is the join between them, and it was the missing link.
    vi.stubEnv("NSFW_THRESHOLD", "0.6");
    vi.stubEnv("NSFW_TIMEOUT_MS", "1234");

    const verdict = await getClassifier().classify(Buffer.from("x"));

    expect(localFactory).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "local", threshold: 0.6, timeoutMs: 1234 }),
    );
    expect(externalFactory).not.toHaveBeenCalled();
    expect(verdict.model).toBe("fake-local");
  });

  it("gives the guard the configured timeout, not a baked-in one", async () => {
    // The guard's own budget is plumbed separately from the one external.ts
    // hands to AbortSignal, so it needs its own test. A classifier that never
    // settles must answer UNKNOWN after NSFW_TIMEOUT_MS; with the plumbing cut
    // and the guard left on the 5s default, nothing resolves inside this
    // test's own 1s budget and it fails rather than passing by accident.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("NSFW_MODE", "local");
    vi.stubEnv("NSFW_TIMEOUT_MS", "20");
    localFactory.mockReturnValueOnce({ classify: vi.fn(() => new Promise<never>(() => {})) });

    const verdict = await getClassifier().classify(Buffer.from("x"));

    expect(verdict).toEqual({ label: "UNKNOWN", score: 0, model: "error" });
    logged.mockRestore();
  }, 1000);

  it("routes a valid external config to createExternalClassifier", async () => {
    vi.stubEnv("NSFW_MODE", "external");
    vi.stubEnv("NSFW_API_URL", "https://classifier.example/v1");
    vi.stubEnv("NSFW_API_KEY", "secret");
    // Named so this test doesn't also trip the legal-processor warning —
    // that path is covered by lib/nsfw/config.test.ts.
    vi.stubEnv("LEGAL_CLASSIFIER_PROCESSOR", "Example Classifier Inc.");

    const verdict = await getClassifier().classify(Buffer.from("x"));

    expect(externalFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "external",
        apiUrl: "https://classifier.example/v1",
        apiKey: "secret",
      }),
    );
    expect(localFactory).not.toHaveBeenCalled();
    expect(verdict.model).toBe("fake-external");
  });

  it("wraps the selected classifier in the failure guard", async () => {
    // The ternary's other half: whichever factory wins must still come back
    // through guard(), or a real crash would reject the promise instead of
    // resolving to UNKNOWN.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("NSFW_MODE", "local");
    localFactory.mockReturnValueOnce({
      classify: vi.fn().mockRejectedValue(new Error("boom")),
    });

    const verdict = await getClassifier().classify(Buffer.from("x"));

    expect(verdict).toEqual({ label: "UNKNOWN", score: 0, model: "error" });
    logged.mockRestore();
  });
});
