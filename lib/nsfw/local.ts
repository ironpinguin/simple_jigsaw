import sharp from "sharp";
import type { NsfwConfig } from "./config";
import type { Classifier } from "./types";
import { labelFor } from "./verdict";

// OwenElliott/image-safety-classifier-xs, MIT, pinned to commit
// 54f4560bd9c5ee92d45dc30418a8f8680e80de6d (see design doc's spike section for
// provenance and sha256). Not committed to git — the Dockerfile fetches it.
const MODEL_ID = "local:image-safety-classifier-xs@54f4560";

const MODEL_INPUT_SIZE = 224;
// The head this module was written against: [NSFL, NSFW, SFW], under this name.
// Class order is fixed by the model's own config.json (pretrained_cfg.label_names).
const MODEL_OUTPUT_NAME = "probabilities";
const EXPECTED_CLASS_COUNT = 3;
// Both classes that mean "do not publish this". NSFL is gore and violence, NSFW
// is explicit content; the score this module returns is the probability the
// image is either, which is what the threshold is compared against.
const UNSAFE_CLASS_INDICES = [0, 1] as const;

/** Returns the probability that `bytes` is explicit, in 0..1. */
type Score = (bytes: Buffer) => Promise<number>;

type InferenceSession = import("onnxruntime-web").InferenceSession;
/** Loads (or re-loads) the ONNX session. Injectable so a test can count and
 * fail loads without the real model or the WASM backend. */
type LoadSession = () => Promise<InferenceSession>;
/** Milliseconds since the epoch. Injectable so the budget check below can be
 * tested without sleeping through a real inference. */
type Clock = () => number;

/**
 * Local mode's own deadline — the counterpart to the AbortSignal external.ts
 * hands to fetch, needed for the same reason and one more specific to here.
 *
 * onnxruntime-web's WASM backend runs the graph on the calling thread
 * (`wasm.proxy` is a browser Web Worker feature and nothing sets it), so while
 * an inference executes the event loop is blocked and the guard's setTimeout
 * cannot fire. The guard is not defeated — pending timers run as soon as the
 * loop is free again — but it answers *late*, after the blocking call returns,
 * rather than at timeoutMs.
 *
 * Two things that leaves this module to handle, and one it cannot:
 *
 * - A load that never settles used to be cached forever, so every later upload
 *   in the process awaited the same dead promise. The load now has its own
 *   deadline and clears the cache when it fires (see getSession).
 * - A request that queued behind other inferences can reach the graph long
 *   after the guard already answered UNKNOWN on its behalf. The budget is
 *   re-checked immediately before the uninterruptible step, which is the last
 *   moment this thread is free to decide not to take it.
 * - Not fixed: an inference already underway cannot be interrupted, so a single
 *   slow image can still overrun timeoutMs. Bounding that needs the graph off
 *   the request thread (worker_threads), which is a deployment change rather
 *   than a patch — and the reason warming the session at startup is on the
 *   follow-up list.
 */
function deadline(ms: number, what: string) {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} exceeded ${ms}ms`)), ms);
  });
  return { expired, cancel: () => clearTimeout(timer) };
}

const defaultLoadSession: LoadSession = async () => {
  const ort = await import("onnxruntime-web");
  return ort.InferenceSession.create(process.env.NSFW_MODEL_PATH ?? "./models/nsfw.onnx");
};

/**
 * The output boundary, checked the way external.ts checks the service's — and
 * for the same reason, which was never carried over here: NSFW_MODEL_PATH is
 * operator-settable and the Dockerfile's sha256 only covers the copy baked into
 * the image, so a model that loads but is not *this* model is reachable. It
 * does not throw; it answers with a plausible number. `as number` then waved
 * that straight into `labelFor`:
 *
 * - a 2-class [NSFW, SFW] head makes index 1 the *safe* probability, so every
 *   explicit image scores ~0.01 and publishes — silently, indefinitely, with
 *   nothing in the log because nothing failed;
 * - a head emitting logits puts 0.4 where a probability belonged (CLEAN),
 *   while its larger logits fall outside 0..1 and read as an intermittently
 *   flaky classifier rather than a wrong one;
 * - a shorter output makes `data[1]` undefined, which becomes NaN, which
 *   `labelFor` holds as UNKNOWN and Prisma then rejects — surfacing as
 *   /api/upload's "could not record the verdict" and pointing the operator at
 *   their database.
 *
 * Each condition throws separately so the guard's console.error names the one
 * that fired. Throwing rather than returning UNKNOWN here is what gets it
 * logged at all (guard.ts), and it is the difference between an operator
 * learning the model is wrong and watching the queue fill up.
 *
 * What this cannot catch: a 3-class head in a *different order*. The arity is
 * right and the value is a probability, so only the pinned sha256 stands
 * between that and a confidently wrong verdict.
 */
function scoreFrom(outputs: Record<string, { data: ArrayLike<unknown> } | undefined>): number {
  const tensor = outputs[MODEL_OUTPUT_NAME];
  if (!tensor) {
    const names = Object.keys(outputs).join(", ") || "none";
    throw new Error(`model has no "${MODEL_OUTPUT_NAME}" output (found: ${names})`);
  }

  const { data } = tensor;
  if (data.length !== EXPECTED_CLASS_COUNT) {
    throw new Error(
      `model returned ${data.length} class scores, expected ${EXPECTED_CLASS_COUNT} ` +
        `— NSFW_MODEL_PATH is probably not ${MODEL_ID}`,
    );
  }

  // Both unsafe classes, not just NSFW. The head is soft-maxed across three
  // classes, so a pure-gore image puts its mass on NSFL and leaves NSFW *low*:
  // reading index 1 alone scored [0.9, 0.05, 0.05] as 0.05 and published it.
  // A moderation feature that ships past gore is not doing the job.
  //
  // Added rather than maxed, because the two are alternatives and the question
  // is whether the image is unsafe at all: on [0.5, 0.45, 0.05] the model is
  // 95% sure it is one or the other and only unsure which, and `max` would read
  // 0.5 and publish it. Equivalent to 1 - SFW, written as the sum so the two
  // indices that matter are the ones named.
  //
  // Every class is validated, not only the ones summed, because an implausible
  // SFW value means the same broken model as an implausible NSFL one.
  let unsafe = 0;
  for (let index = 0; index < EXPECTED_CLASS_COUNT; index++) {
    const value = data[index];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`model returned ${String(value)} for class ${index}, not a usable score`);
    }
    if (value < 0 || value > 1) {
      throw new Error(
        `model returned a class ${index} score outside 0..1: ${value} ` +
          "— logits rather than probabilities?",
      );
    }
    if ((UNSAFE_CLASS_INDICES as readonly number[]).includes(index)) unsafe += value;
  }

  // float32 soft-max does not sum to exactly 1, so the unsafe half can land a
  // hair over it. Clamping keeps a legitimate answer out of labelFor's range
  // check, which would otherwise hold an ordinary image as UNKNOWN. Only the
  // rounding error is absorbed: a genuinely out-of-range class threw above.
  return Math.min(1, unsafe);
}

let sessionPromise: Promise<InferenceSession> | undefined;

/**
 * Cache the in-flight *promise*, not the resolved session. `session ??=
 * await load()` reads `session` before its `await` and assigns only after —
 * so concurrent first calls all observe "not loaded yet" and each start
 * their own load. A burst of uploads right after a restart would then load
 * the 13 MB model once per request and abandon every session but the last,
 * with none of them released. Caching the promise itself closes that window:
 * every caller, including ones that arrive while the first load is still in
 * flight, awaits the very same load.
 *
 * Cleared on rejection *and* on timeout, so neither a transient failure (a bad
 * path, a disk hiccup) nor a load that never settles at all (a stalled mount, a
 * truncated file ORT spins on) poisons the module for the rest of the process —
 * the next call gets to retry instead of every future upload coming back
 * UNKNOWN forever. Only the rejection half used to hold, and a hang is the
 * likelier of the two.
 */
function getSession(loadSession: LoadSession, timeoutMs: number): Promise<InferenceSession> {
  if (!sessionPromise) {
    const load = loadSession();
    // The race below may stop waiting on this before it settles; without a
    // handler a later rejection would surface as an unhandled rejection.
    load.catch(() => {});

    const bound = deadline(timeoutMs, "loading the model");
    sessionPromise = Promise.race([load, bound.expired])
      .finally(bound.cancel)
      .catch((error: unknown) => {
        // A load that was merely slow rather than stuck is then started again
        // by the next upload while the first is still running: at worst one
        // abandoned load per timeoutMs, against an instance that otherwise
        // answers UNKNOWN for the rest of its life.
        sessionPromise = undefined;
        throw error;
      });
  }
  return sessionPromise;
}

function createDefaultRun(loadSession: LoadSession, timeoutMs: number, now: Clock): Score {
  return async (bytes) => {
    const deadlineAt = now() + timeoutMs;
    const ort = await import("onnxruntime-web");
    const session = await getSession(loadSession, timeoutMs);

    // fit: "fill" matches the spike's pipeline exactly (it does not preserve
    // aspect ratio, but this model was verified against that exact distortion).
    // removeAlpha + raw gives interleaved HWC uint8 RGB with no container
    // overhead to parse.
    const { data: hwc } = await sharp(bytes)
      .resize(MODEL_INPUT_SIZE, MODEL_INPUT_SIZE, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // HWC uint8 -> CHW float32, raw 0-255 values. The model's normalisation is
    // baked into the ONNX graph itself (confirmed by the spike), so there is no
    // mean/std or /255 step here — applying one would double-normalise.
    const pixelCount = MODEL_INPUT_SIZE * MODEL_INPUT_SIZE;
    const chw = new Float32Array(3 * pixelCount);
    for (let i = 0; i < pixelCount; i++) {
      chw[i] = hwc[i * 3];
      chw[pixelCount + i] = hwc[i * 3 + 1];
      chw[2 * pixelCount + i] = hwc[i * 3 + 2];
    }

    const input = new ort.Tensor("float32", chw, [1, 3, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE]);

    // The last point this thread is free before the uninterruptible step. Past
    // the budget the guard has already answered UNKNOWN for this upload, so
    // running the graph would spend CPU on an answer nobody reads and delay
    // every request queued behind it. See `deadline` above.
    if (now() >= deadlineAt) {
      throw new Error(`no budget left to run the model within ${timeoutMs}ms`);
    }

    const outputs = await session.run({ image: input });

    // Already soft-maxed by the graph; no further normalisation needed — but
    // not taken on trust either, see scoreFrom.
    return scoreFrom(outputs);
  };
}

export function createLocalClassifier(
  config: NsfwConfig,
  run?: Score,
  loadSession: LoadSession = defaultLoadSession,
  now: Clock = Date.now,
): Classifier {
  // `run`, when supplied, replaces the whole scoring pipeline (what the
  // existing tests inject); `loadSession` only matters for the real
  // pipeline, so it is a separate, independently injectable seam — a test
  // can exercise the real preprocessing while faking just the model load.
  // `now` is the third such seam, for the budget check alone.
  const score = run ?? createDefaultRun(loadSession, config.timeoutMs, now);
  return {
    async classify(bytes) {
      const value = await score(bytes);
      return { label: labelFor(value, config.threshold), score: value, model: MODEL_ID };
    },
  };
}
