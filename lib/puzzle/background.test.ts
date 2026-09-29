import { describe, it, expect } from "vitest";
import {
  BOARD_BACKGROUNDS,
  BOARD_BACKGROUND_COLORS,
  DEFAULT_BOARD_BACKGROUND,
  contrastRatio,
  isBoardBackground,
  relativeLuminance,
  suggestBoardBackground,
  toBoardBackground,
  type Pixels,
} from "./background";

type Rgb = [number, number, number];

/** A `w`×`h` image, each pixel coloured by `colourAt(x, y)`. */
function image(w: number, h: number, colourAt: (x: number, y: number) => Rgb, channels = 4): Pixels {
  const data = new Uint8ClampedArray(w * h * channels);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * channels;
      const [r, g, b] = colourAt(x, y);
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      if (channels === 4) data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h, channels };
}

const plain = (rgb: Rgb, channels = 4) => image(20, 20, () => rgb, channels);

describe("board background presets", () => {
  it("offers eight presets, today's dark one as the default", () => {
    expect(BOARD_BACKGROUNDS).toHaveLength(8);
    expect(DEFAULT_BOARD_BACKGROUND).toBe("dark");
    // The board looked like this before presets existed (#147).
    expect(BOARD_BACKGROUND_COLORS.dark).toBe("#1a1e33");
  });

  it("has a colour for every preset", () => {
    for (const id of BOARD_BACKGROUNDS) {
      expect(BOARD_BACKGROUND_COLORS[id]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("validates stored values and falls back to the default", () => {
    expect(isBoardBackground("cream")).toBe(true);
    expect(isBoardBackground("plaid")).toBe(false);
    expect(isBoardBackground(null)).toBe(false);
    expect(toBoardBackground("felt")).toBe("felt");
    expect(toBoardBackground("plaid")).toBe("dark");
    expect(toBoardBackground(undefined)).toBe("dark");
  });
});

describe("relativeLuminance / contrastRatio", () => {
  it("follows WCAG for black and white", () => {
    expect(relativeLuminance(0, 0, 0)).toBe(0);
    expect(relativeLuminance(255, 255, 255)).toBeCloseTo(1, 10);
    expect(contrastRatio(0, 1)).toBeCloseTo(21, 10);
  });

  it("is symmetric and 1 for equal luminances", () => {
    expect(contrastRatio(0.2, 0.7)).toBeCloseTo(contrastRatio(0.7, 0.2), 10);
    expect(contrastRatio(0.4, 0.4)).toBe(1);
  });
});

describe("suggestBoardBackground", () => {
  it("puts a black picture on a light table", () => {
    const pick = suggestBoardBackground(plain([0, 0, 0]));
    expect(relativeLuminance(...hexRgb(BOARD_BACKGROUND_COLORS[pick]))).toBeGreaterThan(0.5);
  });

  it("puts a white picture on a dark table", () => {
    const pick = suggestBoardBackground(plain([255, 255, 255]));
    expect(relativeLuminance(...hexRgb(BOARD_BACKGROUND_COLORS[pick]))).toBeLessThan(0.05);
  });

  it("picks the preset with the highest contrast for mid-grey", () => {
    const grey = relativeLuminance(128, 128, 128);
    const best = Math.max(
      ...BOARD_BACKGROUNDS.map((id) =>
        contrastRatio(grey, relativeLuminance(...hexRgb(BOARD_BACKGROUND_COLORS[id]))),
      ),
    );
    const pick = suggestBoardBackground(plain([128, 128, 128]));
    expect(contrastRatio(grey, relativeLuminance(...hexRgb(BOARD_BACKGROUND_COLORS[pick])))).toBe(
      best,
    );
  });

  it("reads colourful pictures by their luminance", () => {
    // Saturated yellow is bright, saturated blue is dark.
    expect(suggestBoardBackground(plain([255, 220, 0]))).toBe("dark");
    expect(suggestBoardBackground(plain([20, 30, 200]))).toBe("cream");
  });

  it("weighs the border more than the middle", () => {
    // A dark frame round a bright centre: on average the picture is bright,
    // but its outer pieces are the ones lying against the table.
    const framed = image(40, 40, (x, y) => {
      const edge = x < 4 || y < 4 || x >= 36 || y >= 36;
      return edge ? [0, 0, 0] : [255, 255, 255];
    });
    expect(suggestBoardBackground(framed)).toBe("cream");
  });

  it("accepts RGB as well as RGBA pixels", () => {
    expect(suggestBoardBackground(plain([0, 0, 0], 3))).toBe(
      suggestBoardBackground(plain([0, 0, 0], 4)),
    );
    expect(suggestBoardBackground(plain([255, 255, 255], 3))).toBe("dark");
  });

  it("ignores transparent pixels instead of reading them as black", () => {
    // A white logo on a transparent PNG: canvas decodes the clear border as
    // (0, 0, 0, 0). Its pieces are white, so the table must be dark.
    const w = 40;
    const data = new Uint8ClampedArray(w * w * 4);
    for (let y = 10; y < 30; y++) {
      for (let x = 10; x < 30; x++) data.set([255, 255, 255, 255], (y * w + x) * 4);
    }
    expect(suggestBoardBackground({ data, width: w, height: w, channels: 4 })).toBe("dark");
  });

  it("falls back to the default for a fully transparent image", () => {
    const data = new Uint8ClampedArray(10 * 10 * 4);
    expect(suggestBoardBackground({ data, width: 10, height: 10, channels: 4 })).toBe("dark");
  });

  it("falls back to the default for an empty image", () => {
    expect(suggestBoardBackground({ data: new Uint8Array(0), width: 0, height: 0, channels: 4 })).toBe(
      "dark",
    );
  });
});

function hexRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
