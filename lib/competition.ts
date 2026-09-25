// Competition rules (#119): when a competition is open, which submitted times
// are believable, and what makes a display name acceptable. Pure, so the solver
// can show the same verdicts the API enforces — the signing lives separately in
// lib/competition-token.ts, because node:crypto must stay out of client bundles.

import { z } from "zod";
import { PIECE_PRESETS } from "./puzzle/grid";

export interface CompetitionWindow {
  startsAt: Date | null;
  endsAt: Date | null;
}

export type CompetitionPhase = "UPCOMING" | "OPEN" | "CLOSED";

/** Where `now` falls in the window. The end is exclusive, the start inclusive. */
export function competitionPhase({ startsAt, endsAt }: CompetitionWindow, now: Date): CompetitionPhase {
  if (startsAt && now < startsAt) return "UPCOMING";
  if (endsAt && now >= endsAt) return "CLOSED";
  return "OPEN";
}

/**
 * How long a start token stays good. A day is far longer than any plausible
 * solve, and short enough that a leaked token is not a lasting ticket.
 */
export const ATTEMPT_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * The fastest time believed for a piece count — half a second per piece. Not a
 * judgement of how fast a human can be, only a floor under "submitted by hand":
 * a 300-piece puzzle cannot honestly be finished in under two and a half minutes.
 */
export const MIN_MS_PER_PIECE = 500;

export function minimumSolveMs(pieceCount: number): number {
  return pieceCount * MIN_MS_PER_PIECE;
}

/**
 * Slack for the server's own measurement. The start token is stamped when the
 * server answers, the solve is timed in the browser from the first piece picked
 * up — a moment earlier, and the finishing request takes a moment to arrive.
 */
export const CLOCK_SLACK_MS = 5_000;

export type SubmissionVerdict = "OK" | "TOO_FAST" | "LONGER_THAN_ATTEMPT" | "EXPIRED" | "BAD_START";

/**
 * Whether a submitted result could be true. The browser measures the time and
 * could claim anything, so this bounds it from both sides the server can see:
 * no faster than `minimumSolveMs`, and no longer than the time that actually
 * passed since the server issued the start. It does not stop someone replaying
 * a finished board against a fresh start — the issue accepts that for a fun
 * competition.
 */
export function judgeSubmission(input: {
  ms: number;
  pieceCount: number;
  startedAt: number;
  now: number;
}): SubmissionVerdict {
  const { ms, pieceCount, startedAt, now } = input;
  const span = now - startedAt;
  if (span < 0) return "BAD_START";
  if (span > ATTEMPT_MAX_MS) return "EXPIRED";
  if (ms > span + CLOCK_SLACK_MS) return "LONGER_THAN_ATTEMPT";
  if (ms < minimumSolveMs(pieceCount)) return "TOO_FAST";
  return "OK";
}

/** Better when faster; fewer moves only break a tie, as for the local best time. */
export function isBetterResult(
  next: { ms: number; moves: number },
  current: { ms: number; moves: number } | null,
): boolean {
  if (!current) return true;
  return next.ms < current.ms || (next.ms === current.ms && next.moves < current.moves);
}

export const DISPLAY_NAME_MIN = 2;
export const DISPLAY_NAME_MAX = 30;

/**
 * A display name is shown to everyone, so it is held to a plain shape: trimmed,
 * inner whitespace collapsed, no control or invisible formatting characters —
 * nothing that renders as a blank or lets one name look like another's.
 */
export const DisplayNameSchema = z
  .string()
  .transform((s) => s.normalize("NFC").replace(/\s+/g, " ").trim())
  .pipe(
    z
      .string()
      .min(DISPLAY_NAME_MIN)
      .max(DISPLAY_NAME_MAX)
      .refine((s) => !/[\p{Cc}\p{Cf}]/u.test(s)),
  );

/** What the owner sends to turn a puzzle into a competition or change it. */
export const CompetitionSettingsSchema = z
  .object({
    pieceCount: z
      .number()
      .int()
      .refine((n) => (PIECE_PRESETS as readonly number[]).includes(n)),
    startsAt: z.iso.datetime({ offset: true }).nullable(),
    endsAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .refine((s) => !s.startsAt || !s.endsAt || Date.parse(s.startsAt) < Date.parse(s.endsAt), {
    path: ["endsAt"],
  });

export type CompetitionSettings = z.infer<typeof CompetitionSettingsSchema>;

/** How many entries the leaderboard shows. */
export const LEADERBOARD_SIZE = 20;
