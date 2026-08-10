// Reading the NSFW_* variables that every mode shares, in one place, with one
// rule: a classifier the operator asked for and that cannot run holds images
// rather than waving them through, and says so. Uploading still works either
// way — this feature never fails a POST — but "switched off" and "switched on
// and broken" are different answers, and only the first may publish.
//
// NSFW_MODEL_PATH is deliberately not read here: only the local classifier
// (lib/nsfw/local.ts) needs it, so it reads process.env directly instead of
// growing NsfwConfig with a field the other two modes ignore.

/** The values NSFW_MODE accepts. */
export const NSFW_MODES = ["off", "local", "external"] as const;
export type NsfwMode = (typeof NSFW_MODES)[number];

/**
 * What is actually judging uploads — a mode, or `unavailable` for one that was
 * requested but cannot be built (an unknown NSFW_MODE, or `external` with no
 * url/key).
 *
 * `unavailable` is a separate state rather than a fall back to `off` because
 * three call sites branch on this and `off` is the wrong answer at every one:
 * getClassifier would hand back a stub that scores everything CLEAN
 * (lib/nsfw/off.ts), labelWithoutVerdict would read a *missing* verdict as
 * clean and reopen the laundering carve-out (app/api/puzzles/route.ts), and
 * the privacy policy would drop the paragraph disclosing the check. Keeping it
 * distinct makes all three correct without any of them knowing why.
 *
 * There is deliberately no `local` equivalent: a missing or unreadable model
 * fails inside classify(), where guard() already turns it into UNKNOWN.
 */
export type NsfwState = NsfwMode | "unavailable";

export const DEFAULT_THRESHOLD = 0.85;
export const DEFAULT_TIMEOUT_MS = 5000;

export type NsfwConfig = {
  mode: NsfwState;
  threshold: number;
  timeoutMs: number;
  apiUrl: string | null;
  apiKey: string | null;
};

function positiveNumber(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 && value <= max ? value : fallback;
}

export function readNsfwConfig(env: NodeJS.ProcessEnv): NsfwConfig {
  // Empty counts as unset: `NSFW_MODE=` is how a compose file says "leave this
  // alone", and treating it as a typo would hold every upload on an instance
  // that wants no classifier at all.
  const requested = env.NSFW_MODE?.trim() || "off";
  const apiUrl = env.NSFW_API_URL ?? null;
  const apiKey = env.NSFW_API_KEY ?? null;

  let mode: NsfwState;
  if (!(NSFW_MODES as readonly string[]).includes(requested)) {
    console.warn(
      `[nsfw] unknown NSFW_MODE "${requested}"; classification cannot run, so uploads are ` +
        "held for review until this is fixed — set NSFW_MODE=off to publish without a classifier",
    );
    mode = "unavailable";
  } else if (requested === "external" && !(apiUrl && apiKey)) {
    console.warn(
      "[nsfw] NSFW_MODE=external needs NSFW_API_URL and NSFW_API_KEY; classification cannot " +
        "run, so uploads are held for review until this is fixed",
    );
    mode = "unavailable";
  } else {
    mode = requested as NsfwMode;
  }

  // Not a functional problem — classification still runs — but a legal one:
  // every upload is about to leave for a named-nowhere third party, and
  // nothing else checks that LEGAL_CLASSIFIER_PROCESSOR (lib/legal.ts) was
  // set to match. Read directly off `env` rather than importing lib/legal.ts,
  // since NodeJS.ProcessEnv already carries every variable regardless of
  // which module declares it.
  if (mode === "external" && !env.LEGAL_CLASSIFIER_PROCESSOR?.trim()) {
    console.warn(
      "[nsfw] NSFW_MODE=external is set but LEGAL_CLASSIFIER_PROCESSOR is not — uploads are being " +
        "sent to an unnamed processor and the privacy policy does not disclose it; see docs/data-processors.md",
    );
  }

  return {
    mode,
    threshold: positiveNumber(env.NSFW_THRESHOLD, DEFAULT_THRESHOLD, 1),
    timeoutMs: positiveNumber(env.NSFW_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 60_000),
    apiUrl,
    apiKey,
  };
}
