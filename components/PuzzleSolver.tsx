"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import type { PuzzleData } from "./PuzzleBoard";
import ReportDialog from "@/components/ReportDialog";
import { computeGrid, PIECE_PRESETS } from "@/lib/puzzle/grid";
import {
  MAX_STORED_SOLVES,
  SOLVE_KEY_PREFIX,
  solveKeysToPrune,
  solveStateKey,
} from "@/lib/puzzle/solveState";

function BoardLoading() {
  const t = useTranslations("solve");
  return <p className="muted">{t("loading")}</p>;
}

const PuzzleBoard = dynamic(() => import("./PuzzleBoard"), {
  ssr: false,
  loading: () => <BoardLoading />,
});

/**
 * Run `fn` against localStorage, falling back to `whenUnavailable` if storage
 * cannot be used at all.
 *
 * Reaching for `window.localStorage` is itself throwing code: browsers raise
 * `SecurityError` from the *getter* when site data is blocked by policy or the
 * page is a sandboxed iframe. So it is not enough to guard the individual
 * `setItem` — every touch has to go through here, including the reads, which run
 * from effects where an escaping error unwinds past the board (this app has no
 * error boundary) and replaces the puzzle with Next's error page.
 */
function withStorage<T>(fn: (store: Storage) => T, whenUnavailable: T): T {
  try {
    return fn(window.localStorage);
  } catch (err) {
    // Covers both shapes of failure, since neither is recoverable here and the
    // error itself names which one it was: `SecurityError` from the getter, and
    // `QuotaExceededError` from a write against a full origin.
    console.warn("[solve] localStorage unavailable or full; progress is not saved", err);
    return whenUnavailable;
  }
}

/** Every stored solve state, so `saveSolveState` can prune the least recent. */
function storedSolves(store: Storage): Array<{ key: string; raw: string | null }> {
  const entries: Array<{ key: string; raw: string | null }> = [];
  // Enumerate fully before deleting anything: removing inside this loop would
  // shift the indices and skip every other key.
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (key?.startsWith(SOLVE_KEY_PREFIX)) {
      entries.push({ key, raw: store.getItem(key) });
    }
  }
  return entries;
}

export default function PuzzleSolver({
  puzzle,
  title,
}: {
  puzzle: PuzzleData;
  title: string;
}) {
  const t = useTranslations("solve");
  const storageKey = `pc:${puzzle.id}`;
  const solveKey = solveStateKey(puzzle.id);

  // Piece count is per solver: default to the creator's value, but remember the
  // solver's own choice for this puzzle. The stored value is only applied after
  // mount — reading it during render would make the first client render differ
  // from the server's and break hydration. The cost is that a remembered count
  // builds the board twice, so keep the read in the effect below.
  const [pieceCount, setPieceCount] = useState(puzzle.pieceCount);

  useEffect(() => {
    const saved = Number(withStorage((s) => s.getItem(storageKey), null));
    if ((PIECE_PRESETS as readonly number[]).includes(saved)) setPieceCount(saved);
  }, [storageKey]);

  const { cols, rows } = useMemo(
    () => computeGrid(pieceCount, puzzle.imageWidth / puzzle.imageHeight),
    [pieceCount, puzzle.imageWidth, puzzle.imageHeight],
  );
  const total = cols * rows;

  // The board reports which grid its group count belongs to. Keeping that with
  // the count lets a report from the previous grid be ignored: after a
  // piece-count change the board rebuilds asynchronously (its chunk and the
  // image have to load first), and counting against the new `total` in the
  // meantime would show a negative number of connections.
  const [progress, setProgress] = useState<{ groups: number; total: number } | null>(null);
  const [solved, setSolved] = useState(false);
  const [showRef, setShowRef] = useState(true);
  const [showMap, setShowMap] = useState(true);
  const [copied, setCopied] = useState(false);

  const onProgress = useCallback((groups: number, boardTotal: number) => {
    setProgress({ groups, total: boardTotal });
    setSolved(groups === 1);
  }, []);

  const onSolved = useCallback(() => setSolved(true), []);

  // --- The solve state -------------------------------------------------------
  //
  // Where the pieces lie and which of them are joined, kept in the browser only
  // (issue #12) — it deliberately does not follow the solver to another device.
  // The board does the (de)serialising, since it owns the group model and the
  // stage the positions are relative to; every localStorage call lives here, as
  // the `pc:` one above already does.

  const [resetNonce, setResetNonce] = useState(0);

  /**
   * Read by the board from its seeding effect, never during a render — this
   * component *does* render on the server, where there is no storage at all
   * (`PuzzleSolver.test.tsx` hides the globals to keep that honest).
   *
   * Must stay referentially stable: the board lists it in that effect's
   * dependencies, so an inline arrow here would re-seed the board from storage on
   * every parent render — every toolbar toggle would re-assign group ids.
   */
  const loadSolveState = useCallback(
    () => withStorage((s) => s.getItem(solveKey), null),
    [solveKey],
  );

  const saveSolveState = useCallback(
    (raw: string) => {
      withStorage((store) => {
        // Opening puzzle after puzzle would otherwise grow the origin's storage
        // without bound, so retire the least recently played solves first. This is
        // a retention policy rather than a way of making room for this one write:
        // the entries it drops are already past the cap.
        for (const key of solveKeysToPrune(storedSolves(store), solveKey, MAX_STORED_SOLVES)) {
          store.removeItem(key);
        }
        // A full origin throws here, and `withStorage` is what swallows it. That
        // matters most on this path: the board calls this from a Konva `dragend`
        // handler, so an escaping error would not unmount anything — it would
        // surface as an uncaught error out of Konva's event dispatch, once per
        // drop, where no React error boundary can reach it.
        store.setItem(solveKey, raw);
      }, undefined);
    },
    [solveKey],
  );

  function clearSolveState() {
    withStorage((s) => s.removeItem(solveKey), undefined);
  }

  /**
   * Whether there is a saved solve to lose. `connected` cannot answer that: it
   * comes from the board's in-memory report, which is 0 until the board has built
   * — its chunk, the image and the container width all have to resolve first — so
   * for the first moments of every visit a fully joined board reads as untouched.
   */
  function hasStoredSolve() {
    return withStorage((s) => s.getItem(solveKey) !== null, false);
  }

  function startOver() {
    if (!window.confirm(t("confirmReset"))) return;
    clearSolveState();
    // The board re-seeds from its scatter when this changes. That scatter is
    // derived from the puzzle's seed, so starting over gives back the same
    // relative arrangement the link has always had rather than a new random one.
    setResetNonce((n) => n + 1);
    // The board reports again once it has re-seeded; until then say nothing is
    // connected instead of leaving the old count — and the solved banner up.
    setProgress(null);
    setSolved(false);
  }

  // Connections made; total-1 when solved. An unbuilt or just-resized board has
  // not reported for this grid yet, and then nothing is connected.
  const connected = progress?.total === total ? total - progress.groups : 0;

  function changeCount(n: number) {
    if (n === pieceCount) return;
    // Warn if there is progress to lose — either connected on the board in front
    // of the solver, or saved from an earlier visit. Asking about the saved state
    // too is what keeps the prompt honest now that the rebuild deletes something
    // durable: a board still loading reports nothing connected, and gating on that
    // alone would throw a finished puzzle away without a word.
    if ((connected > 0 || hasStoredSolve()) && !window.confirm(t("confirmChange"))) {
      return;
    }
    setPieceCount(n);
    withStorage((s) => s.setItem(storageKey, String(n)), undefined);
    // The new grid could not restore it anyway — `deserialiseSolveState` rejects a
    // cols/rows mismatch — but deleting it here is what the warning promises.
    clearSolveState();
  }

  async function share() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div>
      <div className="solve-toolbar">
        <h1 style={{ margin: 0, fontSize: 22 }}>{title}</h1>
        <span className="progress">
          {t("progress", { connected, total: total - 1 })}
        </span>
        {solved && <span className="solved-banner">{t("solved")}</span>}

        <label style={{ margin: 0, display: "flex", gap: 6, alignItems: "center" }}>
          {t("pieces")}
          <select
            id="piece-count"
            name="pieceCount"
            value={pieceCount}
            onChange={(e) => changeCount(Number(e.target.value))}
            style={{ width: "auto" }}
          >
            {PIECE_PRESETS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>

        <button
          className={`button secondary ${showRef ? "active" : ""}`}
          type="button"
          aria-pressed={showRef}
          onClick={() => setShowRef((v) => !v)}
        >
          {showRef ? t("hideRef") : t("showRef")}
        </button>
        <button
          className={`button secondary ${showMap ? "active" : ""}`}
          type="button"
          aria-pressed={showMap}
          onClick={() => setShowMap((v) => !v)}
        >
          {showMap ? t("hideMap") : t("showMap")}
        </button>
        <button className="button secondary" type="button" onClick={share}>
          {copied ? t("copied") : t("share")}
        </button>
        <button className="button secondary" type="button" onClick={startOver}>
          {t("reset")}
        </button>
        <ReportDialog puzzleId={puzzle.id} />
      </div>

      <p className="muted" style={{ marginTop: -4 }}>
        {t("instructions")}
      </p>

      <div className="solve-fullbleed" style={{ position: "relative" }}>
        {showRef && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/image/${puzzle.imageKey}`}
            alt={t("hideRef")}
            className="reference-thumb"
          />
        )}
        <PuzzleBoard
          puzzle={puzzle}
          cols={cols}
          rows={rows}
          showMinimap={showMap}
          onProgress={onProgress}
          onSolved={onSolved}
          loadSolveState={loadSolveState}
          saveSolveState={saveSolveState}
          resetNonce={resetNonce}
        />
      </div>
    </div>
  );
}
