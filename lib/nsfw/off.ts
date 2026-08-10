import type { Classifier } from "./types";

// The supported way to run Jigsaw without classification: it never reads the
// bytes, never loads a model and costs nothing.
export const offClassifier: Classifier = {
  classify: async () => ({ label: "CLEAN", score: 0, model: "off" }),
};
