"use client";

import { useTranslations } from "next-intl";
import {
  BOARD_BACKGROUNDS,
  BOARD_BACKGROUND_COLORS,
  type BoardBackground,
} from "@/lib/puzzle/background";

/** A row of colour swatches, one per board background preset (#147). */
export default function BoardBackgroundPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: BoardBackground;
  onChange: (value: BoardBackground) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("boardBackground");
  return (
    <div className="swatch-row">
      {BOARD_BACKGROUNDS.map((bg) => (
        <button
          type="button"
          key={bg}
          className={`swatch ${value === bg ? "active" : ""}`}
          style={{ background: BOARD_BACKGROUND_COLORS[bg] }}
          aria-label={t(bg)}
          aria-pressed={value === bg}
          title={t(bg)}
          disabled={disabled}
          onClick={() => onChange(bg)}
        />
      ))}
      <span className="muted">{t(value)}</span>
    </div>
  );
}
