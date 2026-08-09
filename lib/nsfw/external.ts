import type { NsfwConfig } from "./config";
import type { Classifier } from "./types";
import { labelFor } from "./verdict";

/**
 * Classification by a third-party service. Every failure throws — the guard in
 * lib/nsfw/guard.ts turns it into UNKNOWN — so there is one failure policy in
 * the codebase rather than one per mode.
 *
 * Sends the re-encoded WebP, never the original upload. This mode makes the
 * service an Art. 28 processor; see docs/data-processors.md.
 */
export function createExternalClassifier(config: NsfwConfig): Classifier {
  const { apiUrl, apiKey, threshold } = config;
  if (!apiUrl || !apiKey) throw new Error("external classifier needs NSFW_API_URL and NSFW_API_KEY");

  return {
    async classify(bytes) {
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "image/webp",
        },
        body: new Uint8Array(bytes),
      });

      if (!res.ok) throw new Error(`classifier answered ${res.status}`);

      const body = (await res.json()) as { score?: unknown };
      const score = typeof body.score === "number" ? body.score : Number.NaN;
      if (!Number.isFinite(score)) throw new Error("classifier response had no usable score");

      return { label: labelFor(score, threshold), score, model: `external:${new URL(apiUrl).host}` };
    },
  };
}
