// Reading the NSFW_* variables that every mode shares, in one place, with one
// rule: a misconfiguration falls back to `off` and says so. This feature is
// optional, so a typo must leave uploading exactly as it is today rather than
// break it. NSFW_MODEL_PATH is deliberately not read here: only the local
// classifier (lib/nsfw/local.ts) needs it, so it reads process.env directly
// instead of growing NsfwConfig with a field the other two modes ignore.

export const NSFW_MODES = ["off", "local", "external"] as const;
export type NsfwMode = (typeof NSFW_MODES)[number];

export const DEFAULT_THRESHOLD = 0.85;
export const DEFAULT_TIMEOUT_MS = 5000;

export type NsfwConfig = {
  mode: NsfwMode;
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
  const requested = env.NSFW_MODE ?? "off";
  const apiUrl = env.NSFW_API_URL ?? null;
  const apiKey = env.NSFW_API_KEY ?? null;

  let mode: NsfwMode = "off";
  if ((NSFW_MODES as readonly string[]).includes(requested)) {
    mode = requested as NsfwMode;
  } else {
    console.warn(`[nsfw] unknown NSFW_MODE "${requested}"; classification stays off`);
  }

  if (mode === "external" && !(apiUrl && apiKey)) {
    console.warn("[nsfw] NSFW_MODE=external needs NSFW_API_URL and NSFW_API_KEY; staying off");
    mode = "off";
  }

  return {
    mode,
    threshold: positiveNumber(env.NSFW_THRESHOLD, DEFAULT_THRESHOLD, 1),
    timeoutMs: positiveNumber(env.NSFW_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 60_000),
    apiUrl,
    apiKey,
  };
}
