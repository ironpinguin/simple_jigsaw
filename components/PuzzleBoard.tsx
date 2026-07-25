"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Stage, Layer, Image as KImage, Rect } from "react-konva";
import type Konva from "konva";
import { generateEdges } from "@/lib/puzzle/edges";
import { pieceOutlinePath } from "@/lib/puzzle/outline";
import { mulberry32 } from "@/lib/puzzle/prng";

export interface PuzzleData {
  id: string;
  imageKey: string;
  imageWidth: number;
  imageHeight: number;
  cols: number;
  rows: number;
  seed: number;
}

interface Piece {
  id: string;
  row: number;
  col: number;
  canvas: HTMLCanvasElement;
  offsetX: number; // cell-corner position inside the piece canvas
  offsetY: number;
  solvedX: number; // stage coords of the cell corner when solved
  solvedY: number;
  startX: number; // initial scattered position of the cell corner
  startY: number;
}

interface Layout {
  boardW: number;
  boardH: number;
  pieceW: number;
  pieceH: number;
  bx: number;
  by: number;
  stageW: number;
  stageH: number;
  snapDist: number;
  pieces: Piece[];
}

const TAB_FRAC = 0.2;

function useHtmlImage(src: string): HTMLImageElement | null {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    const image = new window.Image();
    image.crossOrigin = "anonymous";
    image.src = src;
    image.onload = () => setImg(image);
    return () => {
      image.onload = null;
    };
  }, [src]);
  return img;
}

function buildLayout(
  puzzle: PuzzleData,
  image: HTMLImageElement,
  containerW: number,
): Layout {
  const { cols, rows, seed } = puzzle;
  const aspect = puzzle.imageWidth / puzzle.imageHeight;

  const stageW = Math.max(320, Math.min(containerW, 1024));
  const boardMaxW = stageW * (stageW < 640 ? 0.96 : 0.58);
  const boardMaxH = 480;
  const s = Math.min(boardMaxW / puzzle.imageWidth, boardMaxH / puzzle.imageHeight);
  const boardW = puzzle.imageWidth * s;
  const boardH = puzzle.imageHeight * s;
  const pieceW = boardW / cols;
  const pieceH = boardH / rows;
  const tabV = TAB_FRAC * pieceW;
  const tabH = TAB_FRAC * pieceH;

  const bx = 16;
  const by = 16;

  // Tray geometry: a strip to the right of the board (if wide enough) plus a
  // strip below it. Pieces are scattered here deterministically from the seed.
  const rightTrayX = bx + boardW + 24;
  const rightTrayW = stageW - rightTrayX - 8;
  const hasRightTray = rightTrayW > pieceW * 1.6;
  const bottomTrayY = by + boardH + 24;
  const bottomTrayH = 220;
  const stageH = bottomTrayY + bottomTrayH;

  const grid = generateEdges(cols, rows, seed);
  const rng = mulberry32(seed ^ 0x9e3779b9);

  const boxW = pieceW + 2 * tabV;
  const boxH = pieceH + 2 * tabH;
  const round = aspect; // silence unused in some builds
  void round;

  const pieces: Piece[] = [];
  let idx = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(boxW);
      canvas.height = Math.ceil(boxH);
      const ctx = canvas.getContext("2d")!;
      const path = new Path2D(pieceOutlinePath(grid, r, c, pieceW, pieceH));

      ctx.save();
      ctx.translate(tabV, tabH);
      ctx.clip(path);
      // Draw the whole scaled board so tabs sample neighbouring image content.
      ctx.drawImage(image, -c * pieceW, -r * pieceH, boardW, boardH);
      ctx.restore();

      ctx.save();
      ctx.translate(tabV, tabH);
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(0,0,0,0.35)";
      ctx.stroke(path);
      ctx.restore();

      // Scatter the cell corner into a tray region.
      let sx: number;
      let sy: number;
      const useRight = hasRightTray && idx % 2 === 0;
      if (useRight) {
        sx = rightTrayX + tabV + rng() * Math.max(1, rightTrayW - boxW);
        sy = by + tabH + rng() * Math.max(1, boardH - boxH);
      } else {
        sx = bx + tabV + rng() * Math.max(1, stageW - bx - 8 - boxW);
        sy = bottomTrayY + tabH + rng() * Math.max(1, bottomTrayH - boxH);
      }

      pieces.push({
        id: `${r}-${c}`,
        row: r,
        col: c,
        canvas,
        offsetX: tabV,
        offsetY: tabH,
        solvedX: bx + c * pieceW,
        solvedY: by + r * pieceH,
        startX: sx,
        startY: sy,
      });
      idx++;
    }
  }

  const snapDist = Math.max(14, 0.3 * Math.min(pieceW, pieceH));

  return { boardW, boardH, pieceW, pieceH, bx, by, stageW, stageH, snapDist, pieces };
}

interface Props {
  puzzle: PuzzleData;
  showGuide: boolean;
  onProgress: (placed: number, total: number) => void;
  onSolved: () => void;
}

export default function PuzzleBoard({ puzzle, showGuide, onProgress, onSolved }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [containerW, setContainerW] = useState(0);
  const image = useHtmlImage(`/api/image/${puzzle.imageKey}`);
  const placedRef = useRef<Set<string>>(new Set());

  // Measure the container width once it is known (locked after first measure to
  // avoid rebuilding the board on every resize).
  useEffect(() => {
    if (!wrapRef.current || containerW > 0) return;
    const w = wrapRef.current.clientWidth;
    if (w > 0) setContainerW(w);
    else {
      const ro = new ResizeObserver((entries) => {
        const cw = entries[0]?.contentRect.width ?? 0;
        if (cw > 0) {
          setContainerW(cw);
          ro.disconnect();
        }
      });
      ro.observe(wrapRef.current);
      return () => ro.disconnect();
    }
  }, [containerW]);

  const layout = useMemo(() => {
    if (!image || containerW === 0) return null;
    return buildLayout(puzzle, image, containerW);
  }, [image, containerW, puzzle]);

  const total = puzzle.cols * puzzle.rows;

  useEffect(() => {
    placedRef.current = new Set();
    onProgress(0, total);
  }, [layout, total, onProgress]);

  function handleDragEnd(piece: Piece, node: Konva.Node, snapDist: number) {
    const dx = node.x() - piece.solvedX;
    const dy = node.y() - piece.solvedY;
    if (Math.hypot(dx, dy) <= snapDist) {
      node.position({ x: piece.solvedX, y: piece.solvedY });
      node.draggable(false);
      node.moveToBottom();
      if (!placedRef.current.has(piece.id)) {
        placedRef.current.add(piece.id);
        onProgress(placedRef.current.size, total);
        if (placedRef.current.size === total) onSolved();
      }
    }
  }

  return (
    <div ref={wrapRef} className="board-wrap" style={{ width: "100%" }}>
      {layout && (
        <Stage width={layout.stageW} height={layout.stageH}>
          <Layer listening={false}>
            <Rect
              x={layout.bx}
              y={layout.by}
              width={layout.boardW}
              height={layout.boardH}
              stroke="#4d6bff"
              strokeWidth={2}
              cornerRadius={4}
            />
            {image && showGuide && (
              <KImage
                image={image}
                x={layout.bx}
                y={layout.by}
                width={layout.boardW}
                height={layout.boardH}
                opacity={0.18}
              />
            )}
          </Layer>
          <Layer>
            {layout.pieces.map((piece) => (
              <KImage
                key={piece.id}
                image={piece.canvas}
                x={piece.startX}
                y={piece.startY}
                offsetX={piece.offsetX}
                offsetY={piece.offsetY}
                name={`piece-${piece.id}`}
                solvedX={piece.solvedX}
                solvedY={piece.solvedY}
                draggable
                onDragStart={(e) => e.target.moveToTop()}
                onDragEnd={(e) => handleDragEnd(piece, e.target, layout.snapDist)}
                onMouseEnter={(e) => {
                  const stage = e.target.getStage();
                  if (stage) stage.container().style.cursor = "grab";
                }}
                onMouseLeave={(e) => {
                  const stage = e.target.getStage();
                  if (stage) stage.container().style.cursor = "default";
                }}
              />
            ))}
          </Layer>
        </Stage>
      )}
    </div>
  );
}
