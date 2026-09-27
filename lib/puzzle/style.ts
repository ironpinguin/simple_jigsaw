// Piece styles. The column is a plain string (SQLite has no enums), so the
// allowed values live here and are validated in code, like ../roles.ts.
//
// "classic" is the original shape and must never change: shared links render
// from (cols, rows, seed, style), so altering it would reshape existing puzzles.

export const PIECE_STYLES = ["classic", "wooden"] as const;
export type PieceStyle = (typeof PIECE_STYLES)[number];

export const DEFAULT_PIECE_STYLE: PieceStyle = "classic";

export function isPieceStyle(value: unknown): value is PieceStyle {
  return typeof value === "string" && (PIECE_STYLES as readonly string[]).includes(value);
}

/** A stored value, or the default when it is missing or unknown. */
export function toPieceStyle(value: unknown): PieceStyle {
  return isPieceStyle(value) ? value : DEFAULT_PIECE_STYLE;
}
