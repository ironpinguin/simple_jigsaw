"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import type { PuzzleData } from "./PuzzleBoard";
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

/** Every stored solve state, so `saveSolveState` can prune the oldest. */
function storedSolves(): Array<{ key: string; raw: string | null }> {
  const entries: Array<{ key: string; raw: string | null }> = [];
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i);
    if (key?.startsWith(SOLVE_KEY_PREFIX)) {
      entries.push({ key, raw: window.localStorage.getItem(key) });
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
    const saved = Number(window.localStorage.getItem(storageKey));
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

  // Where the pieces lie and which of them are joined, kept in the browser only
  // (issue #12) — it deliberately does not follow the solver to another device.
  // The board does the (de)serialising, since it owns the group model and the
  // stage the positions are relative to; every localStorage call lives here, as
  // the `pc:` one above already does.
  const [resetNonce, setResetNonce] = useState(0);

  // The board calls this from an effect, never while rendering: the server has no
  // localStorage, and reading storage during render is exactly what broke
  // hydration in issue #7.
  const loadSolveState = useCallback(() => window.localStorage.getItem(solveKey), [solveKey]);

  const saveSolveState = useCallback(
    (raw: string) => {
      // Opening puzzle after puzzle would otherwise fill the origin's storage for
      // good, so retire the least recently played solves first.
      for (const key of solveKeysToPrune(storedSolves(), solveKey, MAX_STORED_SOLVES)) {
        window.localStorage.removeItem(key);
      }
      try {
        window.localStorage.setItem(solveKey, raw);
      } catch {
        // Storage full or blocked (quota, private mode). This runs inside a drop
        // handler, so throwing would take the board down — the puzzle has to stay
        // playable and only give up on being resumable.
      }
    },
    [solveKey],
  );

  function clearSolveState() {
    window.localStorage.removeItem(solveKey);
  }

  function startOver() {
    if (!window.confirm(t("confirmReset"))) return;
    clearSolveState();
    // The board re-seeds from its scatter when this changes. That scatter is
    // derived from the puzzle's seed, so starting over gives back the arrangement
    // the link has always had rather than a new random one.
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
    // Warn if the solver has already connected pieces (rebuild resets progress).
    if (connected > 0 && !window.confirm(t("confirmChange"))) {
      return;
    }
    setPieceCount(n);
    window.localStorage.setItem(storageKey, String(n));
    // A state for the old grid is unusable anyway — `deserialiseSolveState`
    // rejects it — but dropping it here is what the warning above promises.
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
