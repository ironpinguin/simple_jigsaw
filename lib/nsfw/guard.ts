import type { Classifier } from "./types";

/**
 * The failure policy, in exactly one place: every mode is wrapped in this, so
 * `local.ts` and `external.ts` need no error handling of their own and cannot
 * drift apart on what a failure means.
 *
 * A timeout or a throw becomes UNKNOWN, which `requiresReview` treats like a
 * hit — the upload still succeeds, but the puzzle is held for review. Logged,
 * because a permanently broken classifier must not be indistinguishable from
 * a clean instance.
 */
export function guard(inner: Classifier, timeoutMs: number): Classifier {
  return {
    async classify(bytes) {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          inner.classify(bytes),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
          }),
        ]);
      } catch (error) {
        console.error("[nsfw] classification failed; holding the image for review:", error);
        return { label: "UNKNOWN", score: 0, model: "error" };
      } finally {
        // Or a 5s handle keeps the event loop busy after every fast upload.
        if (timer) clearTimeout(timer);
      }
    },
  };
}
