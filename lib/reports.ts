// Report "enum" values as string unions (same reasoning as lib/roles.ts: the
// DB columns are plain strings so one schema runs on Postgres and SQLite).
// Pure and dependency-free so client components can import the value sets;
// the reporter-IP hashing lives in lib/report-ip.ts (node:crypto, server-only).

export const REPORT_CATEGORIES = ["NSFW", "ILLEGAL", "COPYRIGHT", "OTHER"] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

// Guard for DB → typed-value boundaries: category columns are plain strings,
// so anything read back must be narrowed before it reaches a translation
// lookup like t(`category${category}`), which throws on an unknown key.
export function isReportCategory(value: string): value is ReportCategory {
  return (REPORT_CATEGORIES as readonly string[]).includes(value);
}

export const REPORT_STATUSES = ["OPEN", "TAKEDOWN", "DISMISSED"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/** Same DB → typed-value boundary as isReportCategory, for the status column. */
export function isReportStatus(value: string): value is ReportStatus {
  return (REPORT_STATUSES as readonly string[]).includes(value);
}

/** The decisions a report can be resolved with — everything except OPEN. */
export type ReportDecision = Exclude<ReportStatus, "OPEN">;

/** Reports allowed per IP hash per window before the endpoint answers 429. */
export const REPORT_RATE_LIMIT = 5;
export const REPORT_RATE_WINDOW_MS = 60 * 60 * 1000;

/** Message length bounds, shared by the API schema and the report form. */
export const REPORT_MESSAGE_MIN = 10;
export const REPORT_MESSAGE_MAX = 2000;
