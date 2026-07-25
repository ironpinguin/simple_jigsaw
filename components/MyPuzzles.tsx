"use client";

import Link from "next/link";
import { useState } from "react";

interface PuzzleSummary {
  id: string;
  title: string;
  imageKey: string;
  pieceCount: number;
}

export default function MyPuzzles({ initial }: { initial: PuzzleSummary[] }) {
  const [puzzles, setPuzzles] = useState(initial);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function share(id: string) {
    const url = `${window.location.origin}/puzzle/${id}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(id);
      setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 2000);
    } catch {
      /* clipboard unavailable */
    }
  }

  async function remove(id: string) {
    if (!confirm("Dieses Puzzle wirklich löschen?")) return;
    setBusyId(id);
    const res = await fetch(`/api/puzzles/${id}`, { method: "DELETE" });
    setBusyId(null);
    if (res.ok) {
      setPuzzles((list) => list.filter((p) => p.id !== id));
    } else {
      alert("Löschen fehlgeschlagen.");
    }
  }

  return (
    <div className="grid-cards">
      {puzzles.map((p) => (
        <div key={p.id} className="card puzzle-card">
          <Link href={`/puzzle/${p.id}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/api/image/${p.imageKey}`} alt={p.title} />
          </Link>
          <h3>{p.title}</h3>
          <p className="muted" style={{ margin: 0 }}>
            {p.pieceCount} Teile
          </p>
          <div className="card-actions">
            <Link href={`/puzzle/${p.id}`} className="button">
              Lösen
            </Link>
            <button className="button secondary" type="button" onClick={() => share(p.id)}>
              {copiedId === p.id ? "Kopiert!" : "Teilen"}
            </button>
            <button
              className="button danger"
              type="button"
              disabled={busyId === p.id}
              onClick={() => remove(p.id)}
            >
              Löschen
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
