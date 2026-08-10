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

// A few real pixels, decoded by the real sharp step; nothing here touches
// onnxruntime-web's WASM backend or the network.
const tinyImage = () =>
  sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .png()
    .toBuffer();

/**
 * Stands in for the ONNX session: records the feeds it is handed and answers
 * with fixed probabilities. Cast past the real `InferenceSession` type at the
 * call site, the same way guard.test.ts casts a fake `Classifier` — the fake
 * only needs to satisfy what `createDefaultRun` actually calls.
 */
function fakeSession(probabilities: number[] = [0.1, 0.2, 0.7]) {
  return { run: vi.fn(async () => ({ probabilities: { data: probabilities } })) };
}

type LoadSession = Parameters<typeof createLocalClassifier>[2];

describe("createLocalClassifier", () => {
  it("turns the model's score into a verdict", async () => {
    const run = vi.fn(async () => 0.93);
    const verdict = await createLocalClassifier(config, run).classify(Buffer.from("x"));

    expect(verdict.label).toBe("FLAGGED");
    expect(verdict.score).toBe(0.93);
  });

  it("judges against the configured threshold, not a baked-in one", async () => {
    // Both directions on one score, so no literal can satisfy this: 0.6 is
    // CLEAN at 0.85 and FLAGGED at 0.5. Without it, replacing
    // `config.threshold` with the default passes the whole suite, and an
    // operator who lowers NSFW_THRESHOLD because the model under-flags gets
    // no classification change and nothing in the log to say so.
    const run = vi.fn(async () => 0.6);

    const lenient = await createLocalClassifier({ ...config, threshold: 0.85 }, run)
      .classify(Buffer.from("x"));
    const strict = await createLocalClassifier({ ...config, threshold: 0.5 }, run)
      .classify(Buffer.from("x"));

    expect(lenient.label).toBe("CLEAN");
    expect(strict.label).toBe("FLAGGED");
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

  it("gives up on a load that hangs, so a retry can still succeed", async () => {
    // What the old comment denied: clearing the cache only in `.catch` covers a
    // load that *rejects*, never one that does not settle at all — a stalled
    // mount, a truncated file ORT spins on. That promise stayed cached for the
    // life of the process, so every later upload awaited the same dead load and
    // came back UNKNOWN forever. A hang is the likelier I/O failure of the two.
    //
    // The 2s test budget also pins the deadline to config.timeoutMs: with the
    // 5s default hardcoded instead, nothing settles in time and this fails.
    const { createLocalClassifier } = await import("./local");
    const bytes = await tinyImage();
    const session = fakeSession();
    const loadSession = vi
      .fn()
      .mockReturnValueOnce(new Promise(() => {})) // never settles
      .mockResolvedValueOnce(session);
    const tight = createLocalClassifier(
      { ...config, timeoutMs: 20 },
      undefined,
      loadSession as LoadSession,
    );

    await expect(tight.classify(bytes)).rejects.toThrow(/model/i);

    // Same module state, a realistic budget — the retry the old code made
    // impossible. Deliberately not the 20ms one: that budget covers the load
    // deadline being tested above, not a whole decode-and-infer pass, and
    // reusing it would make this assertion a race against the machine.
    const roomy = createLocalClassifier(
      { ...config, timeoutMs: 5_000 },
      undefined,
      loadSession as LoadSession,
    );
    const verdict = await roomy.classify(bytes);

    expect(verdict.score).toBe(0.2);
    expect(loadSession).toHaveBeenCalledTimes(2);
  }, 2000);

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

// The half of the timeout that the guard cannot enforce for this mode. The WASM
// backend runs the graph on the calling thread, so while an inference executes
// the guard's setTimeout cannot fire; it answers late, once the loop is free.
// These pin the parts local.ts can decide for itself.
describe("the inference budget", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("does not start an inference whose answer is already too late", async () => {
    // The real sequence: uploads queue behind each other because the thread is
    // blocked, so this request reaches the graph long after the guard already
    // answered UNKNOWN on its behalf. Running it then burns CPU on an answer
    // nobody will read and pushes back everything still queued behind it. The
    // clock is injected because the alternative is sleeping through a real
    // inference to observe it.
    const { createLocalClassifier } = await import("./local");
    const bytes = await tinyImage();
    const session = fakeSession();
    let t = 1_000;
    const now = () => (t += 100); // 1100 at entry, 1200 at the pre-run check
    const classifier = createLocalClassifier(
      { ...config, timeoutMs: 50 },
      undefined,
      (async () => session) as unknown as LoadSession,
      now,
    );

    await expect(classifier.classify(bytes)).rejects.toThrow(/budget/);
    expect(session.run).not.toHaveBeenCalled();
  });

  it("runs the inference while the budget is intact", async () => {
    // The other direction, so the check above cannot be satisfied by simply
    // refusing everything.
    const { createLocalClassifier } = await import("./local");
    const bytes = await tinyImage();
    const session = fakeSession();
    const classifier = createLocalClassifier(
      { ...config, timeoutMs: 50 },
      undefined,
      (async () => session) as unknown as LoadSession,
      () => 1_000, // no time passes at all
    );

    const verdict = await classifier.classify(bytes);

    expect(verdict.score).toBe(0.2);
    expect(session.run).toHaveBeenCalledTimes(1);
  });
});

// The other end of the same concern: what the model hands *back*. The input
// tensor tests below pin what this module puts in; these pin that it refuses to
// believe an answer that cannot have come from this model. NSFW_MODEL_PATH is
// operator-settable and the Dockerfile's sha256 only covers the copy baked into
// the image, so a model that loads but is not this one is reachable — and it
// answers with a plausible number rather than an error.
describe("the model's output", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function classifyWith(outputs: unknown) {
    const { createLocalClassifier } = await import("./local");
    const bytes = await tinyImage();
    // Through `unknown`: the fake session only implements the one method
    // createDefaultRun calls, so it does not overlap InferenceSession enough
    // for a direct cast.
    const loadSession = vi.fn(async () => ({
      run: vi.fn(async () => outputs),
    })) as unknown as LoadSession;
    return createLocalClassifier(config, undefined, loadSession).classify(bytes);
  }

  it("rejects a head with the wrong number of classes", async () => {
    // The quiet catastrophe: a 2-class [NSFW, SFW] head makes index 1 the
    // *safe* probability, so every explicit image scores ~0.01 and publishes,
    // for as long as the model stays in place, with nothing in the log.
    await expect(classifyWith({ probabilities: { data: [0.01, 0.99] } })).rejects.toThrow(
      /2 class/,
    );
  });

  it("rejects logits where probabilities were expected", async () => {
    // The dangerous sibling is a *small* logit like 0.4, which is in range and
    // reads as CLEAN — undetectable from here. That is exactly why an
    // out-of-range value has to be loud instead of quietly held as UNKNOWN:
    // the same broken model produces both, and only one of them is visible.
    await expect(classifyWith({ probabilities: { data: [1.2, 4.2, -3.1] } })).rejects.toThrow(
      /outside 0\.\.1/,
    );
  });

  it("rejects a non-numeric score rather than passing NaN on", async () => {
    // NaN reaches labelFor, holds as UNKNOWN, then Prisma rejects the row and
    // /api/upload logs "could not record the verdict" — pointing the operator
    // at their database for what is really the wrong model.
    await expect(
      classifyWith({ probabilities: { data: [0.1, Number.NaN, 0.7] } }),
    ).rejects.toThrow(/not a usable score/);
  });

  it("rejects a model whose output is named something else", async () => {
    // Without this the destructure throws a bare TypeError, which the guard
    // logs as "Cannot read properties of undefined" — true, and useless.
    await expect(classifyWith({ logits: { data: [0.1, 0.2, 0.7] } })).rejects.toThrow(
      /probabilities/,
    );
  });

  it("accepts the shape the real model produces", async () => {
    const verdict = await classifyWith({ probabilities: { data: [0.1, 0.2, 0.7] } });

    expect(verdict.score).toBe(0.2);
  });

  it.each([0, 1])("accepts the boundary probability %s", async (score) => {
    // labelFor deliberately accepts both ends, so the range check must not be
    // stricter than the thing it is protecting.
    const verdict = await classifyWith({ probabilities: { data: [0.1, score, 0.7] } });

    expect(verdict.score).toBe(score);
  });
});

// What the model is actually handed. Nothing asserted this before: the fake
// session received the feeds and dropped them, so a refactor that scaled to
// 0..1, applied ImageNet mean/std or emitted BGR or HWC would pass every test
// here while degrading classification to noise — and noise reads mostly as a
// *low* NSFW score, so the feature would fail open, silently.
describe("the input tensor", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  const SIZE = 224;

  // Already 224×224, so the pipeline's `fit: "fill"` resize is an identity
  // transform and the bytes reaching the tensor are exactly the ones written
  // here — literal expected values, not values re-derived from sharp. PNG is
  // lossless, and every pixel differs from its neighbours in all three
  // channels, so a swapped plane or a missed transposition cannot coincide.
  function knownPixels() {
    const raw = Buffer.alloc(SIZE * SIZE * 3);
    for (let i = 0; i < SIZE * SIZE; i++) {
      raw[i * 3] = (i + 13) % 251; // R: 13, 14, 15, …
      raw[i * 3 + 1] = (i * 7 + 71) % 241; // G: 71, 78, 85, …
      raw[i * 3 + 2] = (i * 13 + 137) % 239; // B: 137, 150, 163, …
    }
    return raw;
  }

  async function feedsFrom(raw: Buffer) {
    const { createLocalClassifier } = await import("./local");
    const png = await sharp(raw, { raw: { width: SIZE, height: SIZE, channels: 3 } })
      .png()
      .toBuffer();
    const session = fakeSession();
    const classifier = createLocalClassifier(
      config,
      undefined,
      (async () => session) as LoadSession,
    );

    await classifier.classify(png);

    return session.run.mock.calls[0][0] as { image: { type: string; dims: number[]; data: Float32Array } };
  }

  it("feeds one float32 NCHW tensor under the name the model declares", async () => {
    // "image" and [1, 3, 224, 224] come from the model's own signature (see
    // the spike section of the design doc); a rename or a reshape is a broken
    // session.run, not a worse score, and must fail here first.
    const feeds = await feedsFrom(knownPixels());

    expect(Object.keys(feeds)).toEqual(["image"]);
    expect(feeds.image.type).toBe("float32");
    expect(feeds.image.dims).toEqual([1, 3, SIZE, SIZE]);
    expect(feeds.image.data).toBeInstanceOf(Float32Array);
    expect(feeds.image.data.length).toBe(3 * SIZE * SIZE);
  });

  it("transposes HWC to CHW as raw 0-255 R, G, B planes", async () => {
    const raw = knownPixels();
    const feeds = await feedsFrom(raw);
    const { data } = feeds.image;
    const plane = SIZE * SIZE;

    // The first three pixels, plane by plane. Interleaved HWC would put
    // 13, 71, 137 at the head; BGR would start the first plane at 137; a /255
    // or a mean/std step would put fractions here instead of the model's
    // expected raw byte values, which the ONNX graph normalises itself.
    expect([data[0], data[1], data[2]]).toEqual([13, 14, 15]);
    expect([data[plane], data[plane + 1], data[plane + 2]]).toEqual([71, 78, 85]);
    expect([data[2 * plane], data[2 * plane + 1], data[2 * plane + 2]]).toEqual([137, 150, 163]);

    // …and the very last value, so the transposition is pinned across the
    // whole buffer rather than only at its head.
    const lastPixel = plane - 1;
    expect(data[3 * plane - 1]).toBe(raw[lastPixel * 3 + 2]);
  });

  it("reads the NSFW class from the output, not NSFL or SFW", async () => {
    // `probabilities` is [NSFL, NSFW, SFW], fixed by the model's own
    // config.json (pretrained_cfg.label_names). Index 0 or 2 would still be a
    // plausible-looking probability while measuring something else entirely —
    // SFW in particular is near 1 for exactly the images that must be held.
    const { createLocalClassifier } = await import("./local");
    const session = fakeSession([0.11, 0.22, 0.67]);
    const classifier = createLocalClassifier(
      config,
      undefined,
      (async () => session) as LoadSession,
    );

    const verdict = await classifier.classify(await tinyImage());

    expect(verdict.score).toBe(0.22);
  });
});
