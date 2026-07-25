// Pure ban-matching helpers (no DB, no framework) so they can be unit-tested.
// A ban either matches a full email address (EMAIL) or a whole domain (DOMAIN).

export type BanKind = "EMAIL" | "DOMAIN";

export interface BanEntry {
  value: string; // stored lowercased
  type: BanKind;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** The domain part of an email, lowercased, or null if the address is malformed. */
export function domainOf(email: string): string | null {
  const e = normalizeEmail(email);
  const at = e.lastIndexOf("@");
  if (at <= 0 || at === e.length - 1) return null;
  return e.slice(at + 1);
}

/** True if `email` matches any ban entry (exact address or its domain). */
export function isEmailBanned(email: string, bans: BanEntry[]): boolean {
  const e = normalizeEmail(email);
  const d = domainOf(e);
  return bans.some((b) =>
    b.type === "EMAIL" ? b.value === e : d !== null && b.value === d,
  );
}

/** Normalize a ban value for storage (email lowercased, domain lowercased & @-stripped). */
export function normalizeBanValue(value: string, type: BanKind): string {
  const v = value.trim().toLowerCase();
  if (type === "DOMAIN") return v.startsWith("@") ? v.slice(1) : v;
  return v;
}
