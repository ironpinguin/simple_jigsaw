import type { Pixels } from "./puzzle/background";

/**
 * Decode an image URL (an object URL of a picked file, typically) into a small
 * RGBA thumbnail for colour analysis (#147), its longer side `size` pixels.
 * The aspect ratio is kept, so the border band suggestBoardBackground measures
 * is as deep on every side as it is on the real picture.
 *
 * Resolves to `null` rather than rejecting when the image cannot be decoded or
 * the browser offers no 2D canvas — a missing suggestion must never block
 * creating a puzzle.
 */
export async function readImagePixels(url: string, size = 64): Promise<Pixels | null> {
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = size / Math.max(img.naturalWidth, img.naturalHeight);
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, width, height);
    const { data } = ctx.getImageData(0, 0, width, height);
    return { data, width, height, channels: 4 };
  } catch {
    return null;
  }
}
