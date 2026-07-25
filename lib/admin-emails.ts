// Parsing of the ADMIN_EMAILS env var — a comma-separated allow-list of
// addresses that are automatically granted the ADMIN role on register/login.

export function parseAdminEmails(raw: string | undefined | null): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isAdminEmail(
  email: string,
  raw: string | undefined | null = process.env.ADMIN_EMAILS,
): boolean {
  return parseAdminEmails(raw).has(email.trim().toLowerCase());
}
