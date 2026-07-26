"use client";

import dynamic from "next/dynamic";
import { useCallback, useMemo, useState } from "react";
import type { PuzzleData } from "./PuzzleBoard";
import { computeGrid, PIECE_PRESETS } from "@/lib/puzzle/grid";

const PuzzleBoard = dynamic(() => import("./PuzzleBoard"), {
  ssr: false,
  loading: () => <p className="muted">Puzzle wird geladen…</p>,
});

export default function PuzzleSolver({
  puzzle,
  title,
}: {
  puzzle: PuzzleData;
  title: string;
}) {
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
    if (groups < total && !window.confirm("Teile-Anzahl ändern? Der aktuelle Fortschritt geht verloren.")) {
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
          {connected} / {total - 1} verbunden
        </span>
        {solved && <span className="solved-banner">🎉 Gelöst!</span>}

        <label style={{ margin: 0, display: "flex", gap: 6, alignItems: "center" }}>
          Teile
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
          {showRef ? "👁 Vorlage ausblenden" : "👁 Vorlage einblenden"}
        </button>
        <button className="button secondary" type="button" onClick={share}>
          {copied ? "Link kopiert!" : "Link teilen"}
        </button>
      </div>

      <p className="muted" style={{ marginTop: -4 }}>
        Ziehe zusammengehörige Teile aneinander — sie rasten ein und lassen sich als
        Gruppe weiterbewegen. Zoomen mit Mausrad/Pinch oder den Buttons; leere Fläche
        ziehen verschiebt die Ansicht.
      </p>

      <div className="solve-fullbleed" style={{ position: "relative" }}>
        {showRef && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/image/${puzzle.imageKey}`}
            alt="Vorlage"
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
