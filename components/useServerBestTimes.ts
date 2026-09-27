"use client";

import { useCallback, useEffect, useRef } from "react";
import { tryFetch } from "@/lib/try-fetch";
import { mergeBestTimes, type BestTimes, type SolveResult } from "@/lib/puzzle/timer";
import type { TokenStore } from "./useCompetitionEntry";

/** The browser's best times for the puzzle; the solver owns every storage call. */
export interface BestStore {
  read(): string | null;
  write(raw: string): void;
}

/**
 * The browser side of a signed-in solver's server-side best times (#127).
 *
 * On opening the puzzle, the server's bests and the browser's are merged —
 * the better wins per piece count — so a best set on another device shows
 * here, and one this browser holds that the server lacks is handed over.
 *
 * A timed solve asks the server for a signed start when its first piece is
 * picked up, kept with the solve like a competition start, and hands it back
 * with a new best. Every request here fails quietly: the browser keeps its own
 * best regardless, and the next visit's merge hands over what did not arrive.
 */
export function useServerBestTimes({
  puzzleId,
  signedIn,
  serverBests,
  store,
  tokens,
  onMerged,
}: {
  puzzleId: string;
  signedIn: boolean;
  /** The server's bests for this solver and puzzle; `null` when not signed in. */
  serverBests: BestTimes | null;
  store: BestStore;
  tokens: TokenStore;
  /** After the merge changed what the browser holds, to show it. */
  onMerged: () => void;
}) {
  const starting = useRef(false);
  const merged = useRef(false);

  // After mount, like every storage read in the solver: reading during render
  // would make the first client render differ from the server's.
  useEffect(() => {
    if (!signedIn || !serverBests || merged.current) return;
    merged.current = true;
    const { raw, upload } = mergeBestTimes(store.read(), serverBests);
    if (raw !== null) {
      store.write(raw);
      onMerged();
    }
    if (Object.keys(upload).length > 0) {
      void tryFetch("best-times", `/api/puzzles/${puzzleId}/best-times/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bests: upload }),
      });
    }
  }, [signedIn, serverBests, store, puzzleId, onMerged]);

  /** Call when a piece of a fresh, timed solve is picked up. */
  const beginAttempt = useCallback(async () => {
    if (!signedIn || starting.current || tokens.get()) return;
    starting.current = true;
    try {
      const res = await tryFetch("best-times", `/api/puzzles/${puzzleId}/best-times/start`, {
        method: "POST",
      });
      const data = res?.ok ? await res.json().catch(() => null) : null;
      if (typeof data?.token === "string") tokens.set(data.token);
    } finally {
      starting.current = false;
    }
  }, [signedIn, puzzleId, tokens]);

  /** Forget the start — the solve it belonged to was started over. */
  const discardAttempt = useCallback(() => tokens.clear(), [tokens]);

  /**
   * Call once the puzzle is finished with a time. Only a new best is sent:
   * the browser's best already includes the server's, so anything else could
   * not improve it. Without a start — begun before signing in, or offline —
   * it goes as an import instead, like a best the browser held before.
   */
  const report = useCallback(
    (pieceCount: number, outcome: SolveResult, isNew: boolean) => {
      const token = tokens.get();
      // Used up either way: one start is one solve.
      tokens.clear();
      if (!signedIn || !isNew) return;
      const [url, body] = token
        ? [`/api/puzzles/${puzzleId}/best-times`, { token, pieceCount, ...outcome }]
        : [`/api/puzzles/${puzzleId}/best-times/import`, { bests: { [pieceCount]: outcome } }];
      void tryFetch("best-times", url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    [signedIn, puzzleId, tokens],
  );

  return { beginAttempt, discardAttempt, report };
}
