// Report "enum" values as string unions (same reasoning as lib/roles.ts: the
// DB columns are plain strings so one schema runs on Postgres and SQLite),
// plus the reporter-IP hashing used by the anonymous report endpoint.

import { createHmac } from "crypto";

export const REPORT_CATEGORIES = ["NSFW", "ILLEGAL", "COPYRIGHT", "OTHER"] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

export const REPORT_STATUSES = ["OPEN", "TAKEDOWN", "DISMISSED"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/** Reports allowed per IP hash per window before the endpoint answers 429. */
export const REPORT_RATE_LIMIT = 5;
export const REPORT_RATE_WINDOW_MS = 60 * 60 * 1000;

/**
 * HMAC of the reporter's IP (last x-forwarded-for entry) so rate limiting
 * and dedup work without ever storing the plain address. The hash uses the
 * LAST x-forwarded-for entry because that is the one appended by the
 * deployment's own trusted reverse proxy — earlier entries are
 * client-supplied and spoofable. Keyed with AUTH_SECRET so the hashes are
 * useless outside this deployment. Without any proxy the header is absent
 * and every visitor shares one collectively rate-limited "unknown" bucket.
 */
export function hashReporterIp(forwardedFor: string | null): string {
  const entries = (forwardedFor ?? "").split(",");
  const ip = entries[entries.length - 1].trim() || "unknown";
  return createHmac("sha256", process.env.AUTH_SECRET ?? "").update(ip).digest("hex");
}
