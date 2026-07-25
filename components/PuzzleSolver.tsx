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
  const total = puzzle.cols * puzzle.rows;
  const [groups, setGroups] = useState(total);
  const [solved, setSolved] = useState(false);
  const [showRef, setShowRef] = useState(true);
  const [copied, setCopied] = useState(false);

  const onProgress = useCallback((g: number) => {
    setGroups(g);
    setSolved(g === 1);
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

  const connected = total - groups; // connections made; total-1 when solved

  return (
    <div>
      <div className="solve-toolbar">
        <h1 style={{ margin: 0, fontSize: 22 }}>{title}</h1>
        <span className="progress">
          {connected} / {total - 1} verbunden
        </span>
        {solved && <span className="solved-banner">🎉 Gelöst!</span>}
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
        Gruppe weiterbewegen. Gelöst, wenn alle Teile verbunden sind.
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
        <PuzzleBoard puzzle={puzzle} onProgress={onProgress} onSolved={onSolved} />
      </div>
    </div>
  );
}
