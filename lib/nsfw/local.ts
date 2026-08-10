import sharp from "sharp";
import type { NsfwConfig } from "./config";
import type { Classifier } from "./types";
import { labelFor } from "./verdict";

// OwenElliott/image-safety-classifier-xs, MIT, pinned to commit
// 54f4560bd9c5ee92d45dc30418a8f8680e80de6d (see design doc's spike section for
// provenance and sha256). Not committed to git — the Dockerfile fetches it.
const MODEL_ID = "local:image-safety-classifier-xs@54f4560";

const MODEL_INPUT_SIZE = 224;
// Class order is fixed by the model's own config.json (pretrained_cfg.label_names);
// index 1 (NSFW) is the explicit-content score this module returns.
const NSFW_CLASS_INDEX = 1;
// The head this module was written against: [NSFL, NSFW, SFW], under this name.
const MODEL_OUTPUT_NAME = "probabilities";
const EXPECTED_CLASS_COUNT = 3;

/** Returns the probability that `bytes` is explicit, in 0..1. */
type Score = (bytes: Buffer) => Promise<number>;

type InferenceSession = import("onnxruntime-web").InferenceSession;
/** Loads (or re-loads) the ONNX session. Injectable so a test can count and
 * fail loads without the real model or the WASM backend. */
type LoadSession = () => Promise<InferenceSession>;

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

  const value = data[NSFW_CLASS_INDEX];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`model returned ${String(value)}, not a usable score`);
  }
  if (value < 0 || value > 1) {
    throw new Error(
      `model returned a score outside 0..1: ${value} — logits rather than probabilities?`,
    );
  }

  return value;
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
 * Cleared on rejection, so a transient failure (a bad path, a disk hiccup)
 * doesn't poison the module for the rest of the process — the next call gets
 * to retry instead of every future upload coming back UNKNOWN forever.
 */
function getSession(loadSession: LoadSession): Promise<InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = loadSession().catch((error: unknown) => {
      sessionPromise = undefined;
      throw error;
    });
  }
  return sessionPromise;
}

function createDefaultRun(loadSession: LoadSession): Score {
  return async (bytes) => {
    const ort = await import("onnxruntime-web");
    const session = await getSession(loadSession);

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
): Classifier {
  // `run`, when supplied, replaces the whole scoring pipeline (what the
  // existing tests inject); `loadSession` only matters for the real
  // pipeline, so it is a separate, independently injectable seam — a test
  // can exercise the real preprocessing while faking just the model load.
  const score = run ?? createDefaultRun(loadSession);
  return {
    async classify(bytes) {
      const value = await score(bytes);
      return { label: labelFor(value, config.threshold), score: value, model: MODEL_ID };
    },
  };
}
