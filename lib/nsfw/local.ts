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

    // Already soft-maxed by the graph; no further normalisation needed.
    return outputs.probabilities.data[NSFW_CLASS_INDEX] as number;
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
