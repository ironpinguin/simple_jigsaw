// Grid computation: turn a target piece count plus an image aspect ratio into a
// concrete cols x rows layout whose pieces are as close to square as possible
// while keeping the total piece count near the requested value.

export interface Grid {
  cols: number;
  rows: number;
}

/** The fixed presets offered in the UI. */
export const PIECE_PRESETS = [12, 48, 108, 300] as const;
export type PiecePreset = (typeof PIECE_PRESETS)[number];

/**
 * Choose cols/rows for `pieceCount` pieces given `aspect` = imageWidth/imageHeight.
 *
 * We want piece aspect (pieceW/pieceH) ≈ 1 (square-ish pieces) which means
 * cols/rows ≈ aspect, and cols*rows ≈ pieceCount. We search a small window of
 * candidate row counts and score each by how far the total is from the target
 * and how far the pieces are from square.
 */
export function computeGrid(pieceCount: number, aspect: number): Grid {
  if (!Number.isFinite(pieceCount) || pieceCount < 1) {
    throw new Error(`pieceCount must be >= 1, got ${pieceCount}`);
  }
  if (!Number.isFinite(aspect) || aspect <= 0) {
    throw new Error(`aspect must be > 0, got ${aspect}`);
  }

  let best: Grid | null = null;
  let bestScore = Infinity;

  const maxRows = Math.max(1, Math.ceil(Math.sqrt(pieceCount / aspect)) + 3);
  for (let rows = 1; rows <= maxRows + 2; rows++) {
    const cols = Math.max(1, Math.round(pieceCount / rows));

    // Deviation from the requested piece count (relative).
    const countPenalty = Math.abs(cols * rows - pieceCount) / pieceCount;

    // Deviation of piece shape from square. pieceAspect = aspect * rows / cols;
    // use log so 2x and 0.5x are penalised equally.
    const pieceAspect = (aspect * rows) / cols;
    const shapePenalty = Math.abs(Math.log(pieceAspect));

    const score = countPenalty * 2 + shapePenalty;
    if (score < bestScore) {
      bestScore = score;
      best = { cols, rows };
    }
  }

  return best as Grid;
}
