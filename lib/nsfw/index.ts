import { readNsfwConfig } from "./config";
import { createExternalClassifier } from "./external";
import { guard } from "./guard";
import { createLocalClassifier } from "./local";
import { offClassifier } from "./off";
import type { Classifier } from "./types";
import { unavailableClassifier } from "./unavailable";

export type { Classifier } from "./types";
export type { Verdict, VerdictLabel } from "./verdict";
export { labelFor, requiresReview, toVerdictLabel } from "./verdict";
export { readNsfwConfig } from "./config";
export type { NsfwMode, NsfwState } from "./config";

let cached: Classifier | undefined;

/**
 * The classifier this process uses, built once. In `off` mode no model is
 * loaded and no request is made: `local.ts` pulls its ONNX runtime inside
 * `classify`, so importing it above costs only the `sharp` binding it imports
 * at the top, not the model.
 *
 * `unavailable` gets its own stub rather than sharing `off`'s: both skip the
 * bytes, but one publishes and the other holds. See NsfwState in config.ts.
 */
export function getClassifier(): Classifier {
  if (cached) return cached;

  const config = readNsfwConfig(process.env);
  if (config.mode === "off" || config.mode === "unavailable") {
    cached = config.mode === "off" ? offClassifier : unavailableClassifier;
    return cached;
  }

  const inner =
    config.mode === "local"
      ? createLocalClassifier(config)
      : createExternalClassifier(config);

  cached = guard(inner, config.timeoutMs);
  return cached;
}

/** Tests only: drop the memoized classifier between cases. */
export function resetClassifierForTests(): void {
  cached = undefined;
}
