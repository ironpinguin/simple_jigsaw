// The competition leaderboard as a CSV file for the puzzle's owner (#139).
// Pure, so the escaping — the part that matters, because display names are
// user input — is testable without a request.

import { formatDuration } from "./puzzle/timer";

export interface CsvEntry {
  rank: number;
  displayName: string;
  ms: number;
  moves: number;
  /** ISO 8601. */
  achievedAt: string;
}

/** Column headings, in the downloader's language. */
export interface CsvHeadings {
  rank: string;
  displayName: string;
  time: string;
  ms: string;
  moves: string;
  achievedAt: string;
}

/**
 * A spreadsheet reads a cell starting with one of these as a formula, and a
 * display name like `=HYPERLINK(…)` would then run in the owner's Excel. A
 * leading apostrophe makes it plain text there and stays visible elsewhere,
 * which is the usual trade-off (OWASP "CSV injection"). Tab and CR are covered
 * too, though DisplayNameSchema already refuses control characters.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value: string | number): string {
  let s = String(value);
  if (typeof value === "string" && FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * RFC 4180 with CRLF line ends, behind a UTF-8 byte order mark — without it,
 * Excel opens the file as Windows-1252 and every umlaut in a name is mangled.
 */
export function leaderboardCsv(entries: readonly CsvEntry[], h: CsvHeadings): string {
  const rows = [
    [h.rank, h.displayName, h.time, h.ms, h.moves, h.achievedAt],
    ...entries.map((e) => [e.rank, e.displayName, formatDuration(e.ms), e.ms, e.moves, e.achievedAt]),
  ];
  return "\uFEFF" + rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

const GERMAN: Record<string, string> = { ä: "ae", ö: "oe", ü: "ue", Ä: "Ae", Ö: "Oe", Ü: "Ue", ß: "ss" };

/**
 * A file name from the puzzle title: ASCII letters, digits and dashes only, so
 * it survives every browser's Content-Disposition handling without an encoded
 * `filename*` — and a title can never smuggle in a path or a quote.
 */
export function leaderboardFileName(title: string): string {
  const slug = title
    // German letters the way they are transliterated, before the accents go.
    .replace(/[äöüÄÖÜß]/g, (ch) => GERMAN[ch])
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return `leaderboard${slug ? `-${slug}` : ""}.csv`;
}
