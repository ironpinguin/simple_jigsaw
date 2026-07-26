"use client";

import dynamic from "next/dynamic";
import { useCallback, useMemo, useState } from "react";
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
  // solver's own choice for this puzzle.
  const [pieceCount, setPieceCount] = useState<number>(() => {
    if (typeof window !== "undefined") {
      const saved = Number(window.localStorage.getItem(storageKey));
      if ((PIECE_PRESETS as readonly number[]).includes(saved)) return saved;
    }
    return puzzle.pieceCount;
  });

  const { cols, rows } = useMemo(
    () => computeGrid(pieceCount, puzzle.imageWidth / puzzle.imageHeight),
    [pieceCount, puzzle.imageWidth, puzzle.imageHeight],
  );
  const total = cols * rows;

  const [groups, setGroups] = useState(total);
  const [solved, setSolved] = useState(false);
  const [showRef, setShowRef] = useState(true);
  const [copied, setCopied] = useState(false);

  const onProgress = useCallback((g: number) => {
    setGroups(g);
    setSolved(g === 1);
  }, []);

  const onSolved = useCallback(() => setSolved(true), []);

  function changeCount(n: number) {
    if (n === pieceCount) return;
    // Warn if the solver has already connected pieces (rebuild resets progress).
    if (groups < total && !window.confirm(t("confirmChange"))) {
      return;
    }
    setPieceCount(n);
    if (typeof window !== "undefined") window.localStorage.setItem(storageKey, String(n));
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

  const connected = total - groups; // connections made; total-1 when solved

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
