import { z } from "zod";
import { passwordField } from "./password";

// Validation shared by the two account-creation endpoints, `/api/register` and
// `/api/invite`. It lives in lib/ so the terms gate — the record of consent the
// whole legal setup depends on — is unit-tested (signup.test.ts) instead of
// only exercised through the routes.

/**
 * The terms gate: z.literal(true), so absent and false both fail. Acceptance
 * is enforced here, not by the form's `required` checkbox, which a stale
 * bundle or a scripted client never renders.
 */
const termsAccepted = z.literal(true);

export const RegisterSchema = z.object({
  email: z.string().email(),
  password: passwordField,
  name: z.string().trim().max(80).optional(),
  termsAccepted,
});

/** Invited users accept the terms when they activate the account. */
export const InviteSchema = z.object({
  token: z.string().min(1),
  password: passwordField,
  termsAccepted,
});

/**
 * The `errors.*` message key for a failed signup parse. Responses carry one
 * message, so the first matching field wins: password beats terms beats the
 * generic fallback.
 */
export function signupErrorKey(
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> }>,
): "passwordMin" | "termsNotAccepted" | "invalidInput" {
  if (issues.some((issue) => issue.path.includes("password"))) return "passwordMin";
  if (issues.some((issue) => issue.path.includes("termsAccepted"))) return "termsNotAccepted";
  return "invalidInput";
}
