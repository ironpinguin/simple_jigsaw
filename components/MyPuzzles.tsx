"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Link, useRouter } from "@/i18n/navigation";

interface PuzzleSummary {
  id: string;
  title: string;
  imageKey: string;
  pieceCount: number;
  isPublic: boolean;
}

export default function MyPuzzles({ initial }: { initial: PuzzleSummary[] }) {
  const t = useTranslations("my");
  const router = useRouter();
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

  // Catches only the network call — a bug in the response handling must not
  // be reported to the user as a failed request (the request may well have
  // succeeded by then).
  async function tryFetch(input: string, init?: RequestInit): Promise<Response | null> {
    try {
      return await fetch(input, init);
    } catch (err) {
      console.error(`[my] request to ${input} failed:`, err);
      return null;
    }
  }

  async function remove(id: string) {
    if (!confirm(t("confirmDelete"))) return;
    setBusyId(id);
    try {
      const res = await tryFetch(`/api/puzzles/${id}`, { method: "DELETE" });
      if (!res) {
        alert(t("deleteFailed"));
      } else if (res.ok) {
        setPuzzles((list) => list.filter((p) => p.id !== id));
      } else if (res.status === 401) {
        router.push("/login?callbackUrl=/my");
      } else {
        const data = await res.json().catch(() => null);
        alert(data?.error ?? t("deleteFailed"));
      }
    } finally {
      setBusyId(null);
    }
  }

  async function toggleVisibility(id: string, isPublic: boolean) {
    setBusyId(id);
    try {
      const res = await tryFetch(`/api/puzzles/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isPublic }),
      });
      if (!res) {
        alert(t("visibilityFailed"));
      } else if (res.ok) {
        // The badge reflects what the server confirmed; a 200 without the
        // expected shape is an API contract break — log it, then fall back to
        // the requested state as the best available guess.
        const data = await res.json().catch(() => null);
        const confirmed: unknown = data?.puzzle?.isPublic;
        if (typeof confirmed !== "boolean") {
          console.error("[my] PATCH answered 200 without puzzle.isPublic:", data);
        }
        const next = typeof confirmed === "boolean" ? confirmed : isPublic;
        // Making a puzzle private rotates its imageKey server-side; without
        // the new key the thumbnail keeps pointing at the rotated-away (404)
        // one until a reload.
        const newKey: unknown = data?.puzzle?.imageKey;
        setPuzzles((list) =>
          list.map((p) =>
            p.id === id
              ? { ...p, isPublic: next, ...(typeof newKey === "string" ? { imageKey: newKey } : {}) }
              : p,
          ),
        );
      } else if (res.status === 401) {
        router.push("/login?callbackUrl=/my");
      } else {
        const data = await res.json().catch(() => null);
        alert(data?.error ?? t("visibilityFailed"));
      }
    } finally {
      setBusyId(null);
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
