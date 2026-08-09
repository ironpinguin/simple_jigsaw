// The classification decision, kept pure so the threshold can be tested
// without a model or a network. Same string-union shape as lib/roles.ts and
// lib/reports.ts, because the DB column is a plain string on both providers.

export const VERDICT_LABELS = ["CLEAN", "FLAGGED", "UNKNOWN"] as const;
export type VerdictLabel = (typeof VERDICT_LABELS)[number];

export type Verdict = {
  label: VerdictLabel;
  /** Probability in 0..1. Zero for `off`, which never looks at the bytes. */
  score: number;
  /** Which model or service judged it, so an old verdict can be re-checked. */
  model: string;
};

/**
 * A score at or above `threshold` is flagged — the threshold is where review
 * starts, not where it starts after. A score outside 0..1 (or NaN) is not a
 * probability at all, so it is `UNKNOWN` rather than quietly clean.
 */
export function labelFor(score: number, threshold: number): VerdictLabel {
  if (!Number.isFinite(score) || score < 0 || score > 1) return "UNKNOWN";
  return score >= threshold ? "FLAGGED" : "CLEAN";
}

/** DB → typed-value boundary, the one place a stored label is validated. */
export function toVerdictLabel(value: string): VerdictLabel | null {
  return (VERDICT_LABELS as readonly string[]).includes(value)
    ? (value as VerdictLabel)
    : null;
}

/** Whether this label must keep the puzzle private and open a report. */
export function requiresReview(label: VerdictLabel): boolean {
  return label !== "CLEAN";
}
