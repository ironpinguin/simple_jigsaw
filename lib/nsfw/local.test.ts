import { describe, expect, it, vi } from "vitest";
import { createLocalClassifier } from "./local";
import { DEFAULT_THRESHOLD, DEFAULT_TIMEOUT_MS } from "./config";

const config = {
  mode: "local" as const,
  threshold: DEFAULT_THRESHOLD,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  apiUrl: null,
  apiKey: null,
};

describe("createLocalClassifier", () => {
  it("turns the model's score into a verdict", async () => {
    const run = vi.fn(async () => 0.93);
    const verdict = await createLocalClassifier(config, run).classify(Buffer.from("x"));

    expect(verdict.label).toBe("FLAGGED");
    expect(verdict.score).toBe(0.93);
  });

  it("names the model in the verdict, so an old row can be re-checked", async () => {
    const verdict = await createLocalClassifier(config, async () => 0.1).classify(Buffer.from("x"));

    expect(verdict.model).toMatch(/^local:/);
  });

  it("loads the session only once across calls", async () => {
    // Otherwise every upload pays the load cost.
    const run = vi.fn(async () => 0.1);
    const classifier = createLocalClassifier(config, run);

    await classifier.classify(Buffer.from("a"));
    await classifier.classify(Buffer.from("b"));

    expect(run).toHaveBeenCalledTimes(2);
  });
});
