"use client";

import { useCallback, useRef, useState } from "react";
import { tryFetch } from "@/lib/try-fetch";
import type { SolveResult } from "@/lib/puzzle/timer";

/** Where the solver's attempt stands with the leaderboard, for the result card. */
export type EntryState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "entered"; rank: number; improved: boolean; best: SolveResult }
  | { kind: "needsName"; error: string | null }
  | { kind: "signIn" }
  /** Finished without a start the server issued — see `finish`. */
  | { kind: "noAttempt" }
  | { kind: "failed"; message: string };

/** The start token's place in storage; the solver owns every storage call. */
export interface TokenStore {
  get(): string | null;
  set(token: string): void;
  clear(): void;
}

/**
 * The browser side of taking part in a competition (#119). An attempt begins
 * with a signed start from the server, fetched when the first piece of a fresh
 * solve is picked up and kept with the solve, so a reload in between does not
 * lose it. Finishing hands it back with the time; the server does the judging.
 */
export function useCompetitionEntry({
  puzzleId,
  enabled,
  signedIn,
  tokens,
  onEntered,
}: {
  puzzleId: string;
  /** Whether the puzzle has a competition at all. */
  enabled: boolean;
  signedIn: boolean;
  tokens: TokenStore;
  /** After an entry landed, e.g. to refresh an open leaderboard. */
  onEntered?: () => void;
}) {
  const [state, setState] = useState<EntryState>({ kind: "idle" });
  const starting = useRef(false);
  /** The finished result waiting for a display name. */
  const pending = useRef<{ outcome: SolveResult; token: string } | null>(null);

  /** Call when a piece of a fresh solve is picked up. Does nothing if there is a start already. */
  const beginAttempt = useCallback(async () => {
    if (!enabled || !signedIn || starting.current || tokens.get()) return;
    starting.current = true;
    try {
      const res = await tryFetch("competition", `/api/competitions/${puzzleId}/start`, {
        method: "POST",
      });
      const data = res?.ok ? await res.json().catch(() => null) : null;
      // Not open yet, closed, or offline: the solve goes on, it just will not count.
      if (typeof data?.token === "string") tokens.set(data.token);
    } finally {
      starting.current = false;
    }
  }, [enabled, signedIn, puzzleId, tokens]);

  /** Forget the attempt — the solve it belonged to was started over. */
  const discardAttempt = useCallback(() => {
    tokens.clear();
    pending.current = null;
    setState({ kind: "idle" });
  }, [tokens]);

  const submit = useCallback(
    async (outcome: SolveResult, token: string, displayName?: string) => {
      setState({ kind: "submitting" });
      const res = await tryFetch("competition", `/api/competitions/${puzzleId}/entries`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, ms: outcome.ms, moves: outcome.moves, displayName }),
      });
      const data = res ? await res.json().catch(() => null) : null;
      if (res?.ok && typeof data?.rank === "number") {
        // Used up: a second submission of the same attempt would only repeat it.
        tokens.clear();
        pending.current = null;
        setState({ kind: "entered", rank: data.rank, improved: !!data.improved, best: data.best });
        onEntered?.();
        return;
      }
      if (res?.status === 409 && data?.code === "displayNameRequired") {
        pending.current = { outcome, token };
        setState({ kind: "needsName", error: null });
        return;
      }
      if (res?.status === 400 && data?.code === "displayNameInvalid" && pending.current) {
        setState({ kind: "needsName", error: data.error ?? null });
        return;
      }
      if (res?.status === 401) {
        setState({ kind: "signIn" });
        return;
      }
      setState({ kind: "failed", message: data?.error ?? "" });
    },
    [puzzleId, tokens, onEntered],
  );

  /**
   * Call once the puzzle is finished. `outcome` is `null` for an untimed solve.
   * No start means the attempt began before signing in, before the competition
   * opened, or while the server could not be reached — it cannot be judged, so
   * it is not sent.
   */
  const finish = useCallback(
    (outcome: SolveResult | null) => {
      if (!enabled) return;
      if (!signedIn) return setState({ kind: "signIn" });
      const token = tokens.get();
      if (!outcome || !token) {
        tokens.clear();
        return setState({ kind: "noAttempt" });
      }
      void submit(outcome, token);
    },
    [enabled, signedIn, tokens, submit],
  );

  /** Answer the display-name question and submit the waiting result with it. */
  const submitName = useCallback(
    (displayName: string) => {
      const waiting = pending.current;
      if (waiting) void submit(waiting.outcome, waiting.token, displayName);
    },
    [submit],
  );

  const dismiss = useCallback(() => setState({ kind: "idle" }), []);

  return { state, beginAttempt, discardAttempt, finish, submitName, dismiss };
}
