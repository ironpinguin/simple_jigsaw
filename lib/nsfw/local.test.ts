import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
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
});

// These exercise the real preprocessing (sharp — a local decode, not the
// network or the model) with a faked session loader, so the caching around
// the ONNX session is tested against the actual code path uploads take, not
// just against the injected `run` seam the tests above use.
describe("the session cache", () => {
  // The cache is module-level state (deliberately — "once per process" means
  // once across every classifier, not once per instance), so each test needs
  // its own fresh module instance. Same pattern as lib/db.test.ts's singleton
  // tests: reset the registry, then re-import.
  beforeEach(() => {
    vi.resetModules();
  });

  // A few real pixels, decoded by the real sharp step; nothing here touches
  // onnxruntime-web's WASM backend or the network.
  const tinyImage = () =>
    sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 20, b: 30 } } })
      .png()
      .toBuffer();

  function fakeSession() {
    return { run: vi.fn(async () => ({ probabilities: { data: [0.1, 0.2, 0.7] } })) };
  }

  // Casts a fake loader past the real `InferenceSession` type, the same way
  // guard.test.ts casts a fake `Classifier` — the fake only needs to satisfy
  // what `createDefaultRun` actually calls (`session.run`).
  type LoadSession = Parameters<typeof createLocalClassifier>[2];

  it("loads the session once for concurrent first calls", async () => {
    const { createLocalClassifier } = await import("./local");
    const bytes = await tinyImage();
    const session = fakeSession();
    const loadSession = vi.fn(async () => session);
    const classifier = createLocalClassifier(config, undefined, loadSession as LoadSession);

    // Four uploads landing in the same tick right after a cold start — the
    // scenario the reviewer reproduced with the naive `session ??= await
    // load()` idiom, where each one starts its own load.
    await Promise.all([
      classifier.classify(bytes),
      classifier.classify(bytes),
      classifier.classify(bytes),
      classifier.classify(bytes),
    ]);

    expect(loadSession).toHaveBeenCalledTimes(1);
  });

  it("reuses the session on a later call without loading again", async () => {
    const { createLocalClassifier } = await import("./local");
    const bytes = await tinyImage();
    const session = fakeSession();
    const loadSession = vi.fn(async () => session);
    const classifier = createLocalClassifier(config, undefined, loadSession as LoadSession);

    await classifier.classify(bytes);
    await classifier.classify(bytes);

    expect(loadSession).toHaveBeenCalledTimes(1);
  });

  it("does not poison the cache when the load fails, so a retry can succeed", async () => {
    const { createLocalClassifier } = await import("./local");
    const bytes = await tinyImage();
    const session = fakeSession();
    const loadSession = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk hiccup"))
      .mockResolvedValueOnce(session);
    const classifier = createLocalClassifier(config, undefined, loadSession as LoadSession);

    await expect(classifier.classify(bytes)).rejects.toThrow("disk hiccup");
    const verdict = await classifier.classify(bytes);

    expect(verdict.score).toBe(0.2);
    expect(loadSession).toHaveBeenCalledTimes(2);
  });
});
