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
 * HMAC of the reporter's IP (first x-forwarded-for entry) so rate limiting
 * and dedup work without ever storing the plain address. Keyed with
 * AUTH_SECRET so the hashes are useless outside this deployment. A missing
 * header falls into one shared "unknown" bucket — collectively rate-limited
 * rather than unlimited.
 */
export function hashReporterIp(forwardedFor: string | null): string {
  const ip = (forwardedFor ?? "").split(",")[0].trim() || "unknown";
  return createHmac("sha256", process.env.AUTH_SECRET ?? "").update(ip).digest("hex");
}
