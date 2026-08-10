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
  const { apiUrl, apiKey, threshold, timeoutMs } = config;
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
        // The guard's timeout only stops *waiting*: it abandons the promise
        // but the request keeps running, so against a hanging service every
        // upload holds a socket and this request's context for however long
        // the service takes, long after the user got their answer. The signal
        // is the inner bound that actually cancels; the guard stays the outer
        // one, and is still what turns the resulting throw into UNKNOWN.
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) throw new Error(`classifier answered ${res.status}`);

      const body = (await res.json()) as { score?: unknown };
      const score = typeof body.score === "number" ? body.score : Number.NaN;
      if (!Number.isFinite(score)) throw new Error("classifier response had no usable score");
      // A finite number outside 0..1 is not a probability either. `labelFor`
      // would hold it as UNKNOWN and say nothing, so a service answering 1.5
      // to everything would queue every single upload with no operational
      // signal at all — the one failure mode here that did not log. Throwing
      // routes it through the guard's console.error like every other failure;
      // `labelFor` keeps its own range check as defence in depth.
      if (score < 0 || score > 1) {
        throw new Error(`classifier returned a score outside 0..1: ${score}`);
      }

      return { label: labelFor(score, threshold), score, model: `external:${new URL(apiUrl).host}` };
    },
  };
}
