import { afterEach, describe, expect, it, vi } from "vitest";
import { getClassifier, resetClassifierForTests } from "./index";

afterEach(() => {
  resetClassifierForTests();
  vi.unstubAllEnvs();
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

  it("falls back to off when the mode is misconfigured", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("NSFW_MODE", "external");   // no url, no key

    const verdict = await getClassifier().classify(Buffer.from("x"));

    expect(verdict.model).toBe("off");
    expect(warned).toHaveBeenCalled();
    warned.mockRestore();
  });
});
