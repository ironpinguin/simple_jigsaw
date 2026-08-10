"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { PIECE_PRESETS } from "@/lib/puzzle/grid";

export default function CreateForm() {
  const t = useTranslations("create");
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [pieceCount, setPieceCount] = useState<number>(48);
  const [isPublic, setIsPublic] = useState(true);
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
      setError(t("chooseImage"));
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
      if (!up.ok) throw new Error(upData.error || t("uploadFailed"));

      // 2) create the puzzle record
      const res = await fetch("/api/puzzles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim() || t("titlePlaceholder"),
          imageKey: upData.imageKey,
          imageWidth: upData.width,
          imageHeight: upData.height,
          pieceCount,
          isPublic,
        }),
      });
      if (res.status === 401) return router.push("/login?callbackUrl=/create");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t("createFailed"));

      router.push(data.pendingReview ? `/puzzle/${data.id}?review=1` : `/puzzle/${data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("genericFail"));
      setBusy(false);
    }
  }

  return (
    <form className="card" style={{ maxWidth: 640, marginTop: 20 }} onSubmit={onSubmit}>
      {error && <p className="error">{error}</p>}

      <div style={{ marginBottom: 16 }}>
        <label htmlFor="file">{t("image")}</label>
        <input id="file" type="file" accept="image/jpeg,image/png,image/webp" onChange={onFileChange} />
      </div>

      {previewUrl && (
        <div style={{ marginBottom: 16 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={previewUrl}
            alt={t("image")}
            style={{ maxWidth: "100%", borderRadius: 8, border: "1px solid var(--border)" }}
          />
        </div>
      )}

      <div style={{ marginBottom: 16 }}>
        <label htmlFor="title">{t("titleField")}</label>
        <input
          id="title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t("titlePlaceholder")}
        />
      </div>

      <div style={{ marginBottom: 20 }}>
        <label>{t("pieces")}</label>
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

      <div style={{ marginBottom: 20 }}>
        <label>{t("visibility")}</label>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: "normal" }}>
          <input
            type="checkbox"
            checked={isPublic}
            onChange={(e) => setIsPublic(e.target.checked)}
          />
          {t("publicLabel")}
        </label>
        <p className="muted" style={{ margin: "4px 0 0" }}>
          {t("publicHint")}
        </p>
      </div>

      <button className="button" type="submit" disabled={busy}>
        {busy ? t("creating") : t("submit")}
      </button>
    </form>
  );
}
