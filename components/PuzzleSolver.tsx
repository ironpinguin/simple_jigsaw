"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import type { PuzzleData } from "./PuzzleBoard";
import { computeGrid, PIECE_PRESETS } from "@/lib/puzzle/grid";

function BoardLoading() {
  const t = useTranslations("solve");
  return <p className="muted">{t("loading")}</p>;
}

const PuzzleBoard = dynamic(() => import("./PuzzleBoard"), {
  ssr: false,
  loading: () => <BoardLoading />,
});

export default function PuzzleSolver({
  puzzle,
  title,
}: {
  puzzle: PuzzleData;
  title: string;
}) {
  const t = useTranslations("solve");
  const storageKey = `pc:${puzzle.id}`;

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
  const [copied, setCopied] = useState(false);

  const onProgress = useCallback((groups: number, boardTotal: number) => {
    setProgress({ groups, total: boardTotal });
    setSolved(groups === 1);
  }, []);

  const onSolved = useCallback(() => setSolved(true), []);

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
        <button className="button secondary" type="button" onClick={share}>
          {copied ? t("copied") : t("share")}
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
          onProgress={onProgress}
          onSolved={onSolved}
        />
      </div>
    </div>
  );
}
