// Board backgrounds (#147). Like the piece style, the column is a plain string
// (SQLite has no enums), so the allowed values live here and are validated in
// code.
//
// "dark" is how the board looked before presets existed and stays the default,
// so existing puzzles keep their look.

export const BOARD_BACKGROUNDS = [
  "dark",
  "charcoal",
  "slate",
  "grey",
  "light",
  "cream",
  "felt",
  "wood",
] as const;
export type BoardBackground = (typeof BOARD_BACKGROUNDS)[number];

export const DEFAULT_BOARD_BACKGROUND: BoardBackground = "dark";

/** Plain colours, chosen so the piece bevel and drop shadow stay visible on each. */
export const BOARD_BACKGROUND_COLORS: Record<BoardBackground, string> = {
  dark: "#1a1e33",
  charcoal: "#2e2e2e",
  slate: "#56606e",
  grey: "#8a8a8a",
  light: "#d9d9d9",
  cream: "#f3ecdc",
  felt: "#2f5d3a",
  wood: "#b08a5a",
};

export function isBoardBackground(value: unknown): value is BoardBackground {
  return typeof value === "string" && (BOARD_BACKGROUNDS as readonly string[]).includes(value);
}

/** A stored value, or the default when it is missing or unknown. */
export function toBoardBackground(value: unknown): BoardBackground {
  return isBoardBackground(value) ? value : DEFAULT_BOARD_BACKGROUND;
}

/**
 * Decoded pixels, row by row: RGB (3 channels) or RGBA (4). With alpha, each
 * pixel counts by its opacity — a transparent area shows the table, not the
 * picture, and decodes as (0, 0, 0, 0) which would otherwise read as black.
 */
export interface Pixels {
  data: ArrayLike<number>;
  width: number;
  height: number;
  channels: number;
}

function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of an sRGB colour, 0 (black) to 1 (white). */
export function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG contrast ratio of two relative luminances, 1 to 21. */
export function contrastRatio(a: number, b: number): number {
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

function hexLuminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return relativeLuminance((n >> 16) & 255, (n >> 8) & 255, n & 255);
}

/** Share of the shorter side that counts as the picture's border. */
const EDGE_BAND = 0.1;
/**
 * How much the border counts against the whole picture. The outer pieces are
 * the ones lying against the table for most of a solve, and loose pieces show
 * their cut edges against it too, so the border decides more than the middle.
 */
const EDGE_WEIGHT = 0.75;

/**
 * The preset with the highest contrast against the picture: the mean relative
 * luminance of its border band, blended with that of the whole picture.
 * Ties go to the earlier preset, so a picture the default suits keeps it.
 *
 * Contrast peaks at an end of the scale, so in practice this answers "dark"
 * (the darkest preset) or "cream" (the lightest); the others are there to be
 * picked by hand.
 */
export function suggestBoardBackground({ data, width, height, channels }: Pixels): BoardBackground {
  if (width <= 0 || height <= 0) return DEFAULT_BOARD_BACKGROUND;

  const band = Math.max(1, Math.round(Math.min(width, height) * EDGE_BAND));
  let edgeSum = 0;
  let edgeWeight = 0;
  let allSum = 0;
  let allWeight = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const alpha = channels === 4 ? data[i + 3] / 255 : 1;
      if (alpha === 0) continue;
      const l = relativeLuminance(data[i], data[i + 1], data[i + 2]) * alpha;
      allSum += l;
      allWeight += alpha;
      if (x < band || y < band || x >= width - band || y >= height - band) {
        edgeSum += l;
        edgeWeight += alpha;
      }
    }
  }
  if (allWeight === 0) return DEFAULT_BOARD_BACKGROUND;
  // A picture whose border is entirely transparent is judged by what is left.
  const edge = edgeWeight > 0 ? edgeSum / edgeWeight : allSum / allWeight;
  const picture = EDGE_WEIGHT * edge + (1 - EDGE_WEIGHT) * (allSum / allWeight);

  let best: BoardBackground = DEFAULT_BOARD_BACKGROUND;
  let bestRatio = -1;
  for (const id of BOARD_BACKGROUNDS) {
    const ratio = contrastRatio(picture, hexLuminance(BOARD_BACKGROUND_COLORS[id]));
    if (ratio > bestRatio) {
      best = id;
      bestRatio = ratio;
    }
  }
  return best;
}
