"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";

interface PuzzleSummary {
  id: string;
  title: string;
  imageKey: string;
  pieceCount: number;
  isPublic: boolean;
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

  async function toggleVisibility(id: string, isPublic: boolean) {
    setBusyId(id);
    const res = await fetch(`/api/puzzles/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isPublic }),
    });
    setBusyId(null);
    if (res.ok) {
      setPuzzles((list) => list.map((p) => (p.id === id ? { ...p, isPublic } : p)));
    } else {
      alert(t("visibilityFailed"));
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
            {t("pieces", { count: p.pieceCount })} · {p.isPublic ? t("public") : t("private")}
          </p>
          <div className="card-actions">
            <Link href={`/puzzle/${p.id}`} className="button">
              {t("solve")}
            </Link>
            <button className="button secondary" type="button" onClick={() => share(p.id)}>
              {copiedId === p.id ? t("copied") : t("share")}
            </button>
            <button
              className="button secondary"
              type="button"
              disabled={busyId === p.id}
              onClick={() => toggleVisibility(p.id, !p.isPublic)}
            >
              {p.isPublic ? t("makePrivate") : t("makePublic")}
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
