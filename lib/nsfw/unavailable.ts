import type { Classifier } from "./types";

// The counterpart to off.ts: classification was asked for and cannot run, so
// nothing reads the bytes here either — but the verdict is UNKNOWN, which
// `requiresReview` holds, rather than the CLEAN that would publish it. Same
// shape as guard()'s failure verdict for the same reason: an operator whose
// classifier is misconfigured should see the images pile up in the moderation
// queue, not discover months later that nothing was ever checked.
//
// `model` is not "error" — that one means a classifier ran and failed, and an
// admin reading the queue needs to tell "nobody looked because the config is
// wrong" from "the model timed out on this image".
export const unavailableClassifier: Classifier = {
  classify: async () => ({ label: "UNKNOWN", score: 0, model: "unavailable" }),
};
