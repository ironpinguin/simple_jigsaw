"use client";

import dynamic from "next/dynamic";
import { useCallback, useState } from "react";
import type { PuzzleData } from "./PuzzleBoard";

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
  const [placed, setPlaced] = useState(0);
  const [total, setTotal] = useState(puzzle.cols * puzzle.rows);
  const [solved, setSolved] = useState(false);
  const [showGuide, setShowGuide] = useState(true);
  const [copied, setCopied] = useState(false);

  const onProgress = useCallback((p: number, t: number) => {
    setPlaced(p);
    setTotal(t);
    if (p < t) setSolved(false);
  }, []);

  const onSolved = useCallback(() => setSolved(true), []);

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
          {placed} / {total} Teilen
        </span>
        {solved && <span className="solved-banner">🎉 Gelöst!</span>}
        <label style={{ margin: 0, display: "flex", gap: 6, alignItems: "center" }}>
          <input
            type="checkbox"
            checked={showGuide}
            style={{ width: "auto" }}
            onChange={(e) => setShowGuide(e.target.checked)}
          />
          Vorlage zeigen
        </label>
        <button className="button secondary" type="button" onClick={share}>
          {copied ? "Link kopiert!" : "Link teilen"}
        </button>
      </div>

      <PuzzleBoard
        puzzle={puzzle}
        showGuide={showGuide}
        onProgress={onProgress}
        onSolved={onSolved}
      />
    </div>
  );
}
