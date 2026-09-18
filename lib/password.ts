import { z } from "zod";
import {
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_LENGTH,
  passwordByteLength,
} from "./password-limits";

/**
 * The password rule, in one place. Four writers have to agree on it —
 * registration, invite activation, admin-created accounts and this change
 * endpoint (plus, later, reset by email) — and before this they each spelled
 * `z.string().min(8)` for themselves. `errors.passwordMin` and
 * `errors.passwordMax` in the message catalogues are the wording that goes
 * with it; passwordErrorKey below picks between them.
 *
 * The limits themselves live in password-limits.ts so that the form can import
 * them without importing zod.
 */
export { PASSWORD_MAX_BYTES, PASSWORD_MIN_LENGTH } from "./password-limits";

export const passwordField = z
  .string()
  .min(PASSWORD_MIN_LENGTH)
  .refine((value) => passwordByteLength(value) <= PASSWORD_MAX_BYTES);

/**
 * The `errors.*` message key for a failed password field, or null when the
 * field is absent from the issues or failed for a reason that is not about
 * length — a missing or non-string password is a malformed client, and telling
 * such a caller "at least 8 characters" describes a rule it did not break.
 */
export function passwordErrorKey(
  issues: ReadonlyArray<{ code?: string; path: ReadonlyArray<PropertyKey> }>,
  field: string,
): "passwordMin" | "passwordMax" | null {
  const issue = issues.find((i) => i.path.includes(field));
  if (!issue) return null;
  if (issue.code === "too_small") return "passwordMin";
  // The byte limit is a refinement, so it arrives as "custom"; "too_big" is
  // covered too in case the rule is ever expressible as a plain .max().
  if (issue.code === "custom" || issue.code === "too_big") return "passwordMax";
  return null;
}
