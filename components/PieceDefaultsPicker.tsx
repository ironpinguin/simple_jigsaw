"use client";

import { useId } from "react";
import { useTranslations } from "next-intl";
import { PIECE_PRESETS } from "@/lib/puzzle/grid";
import { PIECE_STYLES, type PieceStyle } from "@/lib/puzzle/style";

/**
 * A puzzle's default piece count and shape on its card under My puzzles (#150):
 * the same presets as the create form. `locked` is for a competition that is
 * upcoming or running, which fixes both.
 */
export default function PieceDefaultsPicker({
  pieceCount,
  pieceStyle,
  onCountChange,
  onStyleChange,
  disabled = false,
  locked = false,
}: {
  pieceCount: number;
  pieceStyle: PieceStyle;
  onCountChange: (pieceCount: number) => void;
  onStyleChange: (pieceStyle: PieceStyle) => void;
  disabled?: boolean;
  locked?: boolean;
}) {
  const t = useTranslations("my");
  const tCreate = useTranslations("create");
  const tStyle = useTranslations("pieceStyle");
  // Each row names its toggles: a lone "48, pressed" says nothing of pieces.
  const id = useId();
  return (
    <>
      <div style={{ margin: "10px 0" }}>
        <span className="muted" id={`${id}-count`}>
          {tCreate("pieces")}
        </span>
        <div className="preset-row" role="group" aria-labelledby={`${id}-count`}>
          {PIECE_PRESETS.map((n) => (
            <button
              type="button"
              key={n}
              className={`preset ${pieceCount === n ? "active" : ""}`}
              aria-pressed={pieceCount === n}
              disabled={disabled || locked}
              onClick={() => {
                if (n !== pieceCount) onCountChange(n);
              }}
            >
              {n}
            </button>
          ))}
        </div>
      </div>
      <div style={{ margin: "10px 0" }}>
        <span className="muted" id={`${id}-style`}>
          {tStyle("label")}
        </span>
        <div className="preset-row" role="group" aria-labelledby={`${id}-style`}>
          {PIECE_STYLES.map((s) => (
            <button
              type="button"
              key={s}
              className={`preset ${pieceStyle === s ? "active" : ""}`}
              aria-pressed={pieceStyle === s}
              disabled={disabled || locked}
              onClick={() => {
                if (s !== pieceStyle) onStyleChange(s);
              }}
            >
              {tStyle(s)}
            </button>
          ))}
        </div>
        {locked && (
          <p className="muted" style={{ margin: "4px 0 0" }}>
            {t("piecesLocked")}
          </p>
        )}
      </div>
    </>
  );
}
