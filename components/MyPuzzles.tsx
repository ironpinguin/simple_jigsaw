"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";

interface PuzzleSummary {
  id: string;
  title: string;
  imageKey: string;
  pieceCount: number;
}

export default function MyPuzzles({ initial }: { initial: PuzzleSummary[] }) {
  const t = useTranslations("my");
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
    if (!confirm(t("confirmDelete"))) return;
    setBusyId(id);
    const res = await fetch(`/api/puzzles/${id}`, { method: "DELETE" });
    setBusyId(null);
    if (res.ok) {
      setPuzzles((list) => list.filter((p) => p.id !== id));
    } else {
      alert(t("deleteFailed"));
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
            {t("pieces", { count: p.pieceCount })}
          </p>
          <div className="card-actions">
            <Link href={`/puzzle/${p.id}`} className="button">
              {t("solve")}
            </Link>
            <button className="button secondary" type="button" onClick={() => share(p.id)}>
              {copiedId === p.id ? t("copied") : t("share")}
            </button>
            <button
              className="button danger"
              type="button"
              disabled={busyId === p.id}
              onClick={() => remove(p.id)}
            >
              {t("delete")}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
