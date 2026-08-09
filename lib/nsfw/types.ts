import type { Verdict } from "./verdict";

/** One image in, one verdict out. The only thing a mode has to implement. */
export interface Classifier {
  classify(bytes: Buffer): Promise<Verdict>;
}
