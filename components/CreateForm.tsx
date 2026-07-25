"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PIECE_PRESETS } from "@/lib/puzzle/grid";

export default function CreateForm() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [pieceCount, setPieceCount] = useState<number>(48);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    if (f && !title) {
      setTitle(f.name.replace(/\.[^.]+$/, ""));
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!file) {
      setError("Bitte wähle ein Bild aus.");
      return;
    }
    setBusy(true);
    try {
      // 1) upload the image
      const fd = new FormData();
      fd.append("file", file);
      const up = await fetch("/api/upload", { method: "POST", body: fd });
      if (up.status === 401) return router.push("/login?callbackUrl=/create");
      const upData = await up.json();
      if (!up.ok) throw new Error(upData.error || "Upload fehlgeschlagen.");

      // 2) create the puzzle record
      const res = await fetch("/api/puzzles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim() || "Mein Puzzle",
          imageKey: upData.imageKey,
          imageWidth: upData.width,
          imageHeight: upData.height,
          pieceCount,
        }),
      });
      if (res.status === 401) return router.push("/login?callbackUrl=/create");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Puzzle konnte nicht erstellt werden.");

      router.push(`/puzzle/${data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Etwas ist schiefgelaufen.");
      setBusy(false);
    }
  }

  return (
    <form className="card" style={{ maxWidth: 640, marginTop: 20 }} onSubmit={onSubmit}>
      {error && <p className="error">{error}</p>}

      <div style={{ marginBottom: 16 }}>
        <label htmlFor="file">Bild</label>
        <input id="file" type="file" accept="image/jpeg,image/png,image/webp" onChange={onFileChange} />
      </div>

      {previewUrl && (
        <div style={{ marginBottom: 16 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={previewUrl}
            alt="Vorschau"
            style={{ maxWidth: "100%", borderRadius: 8, border: "1px solid var(--border)" }}
          />
        </div>
      )}

      <div style={{ marginBottom: 16 }}>
        <label htmlFor="title">Titel</label>
        <input
          id="title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Mein Puzzle"
        />
      </div>

      <div style={{ marginBottom: 20 }}>
        <label>Teile-Anzahl</label>
        <div className="preset-row">
          {PIECE_PRESETS.map((n) => (
            <button
              type="button"
              key={n}
              className={`preset ${pieceCount === n ? "active" : ""}`}
              onClick={() => setPieceCount(n)}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      <button className="button" type="submit" disabled={busy}>
        {busy ? "Puzzle wird erstellt…" : "Puzzle erstellen"}
      </button>
    </form>
  );
}
