// Whether public self-registration is enabled. Controlled by the
// REGISTRATION_ENABLED env var; enabled unless explicitly set to "false".
// Invites and admin/CLI-created accounts are unaffected by this switch.

export function isRegistrationEnabled(
  raw: string | undefined | null = process.env.REGISTRATION_ENABLED,
): boolean {
  return (raw ?? "true").toLowerCase() !== "false";
}
