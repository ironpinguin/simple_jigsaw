"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Stage, Layer, Group, Image as KImage } from "react-konva";
import type Konva from "konva";
import { generateEdges } from "@/lib/puzzle/edges";
import { pieceOutlinePath } from "@/lib/puzzle/outline";
import { mulberry32 } from "@/lib/puzzle/prng";
import { resolveConnections, type PieceGroup } from "@/lib/puzzle/groups";

export interface PuzzleData {
  id: string;
  imageKey: string;
  imageWidth: number;
  imageHeight: number;
  cols: number;
  rows: number;
  seed: number;
}

interface PieceInfo {
  id: string;
  row: number;
  col: number;
  canvas: HTMLCanvasElement;
  offsetX: number;
  offsetY: number;
  /** Corner position in solved (puzzle) space — constant within any group. */
  solvedX: number;
  solvedY: number;
}

interface Layout {
  pieceW: number;
  pieceH: number;
  stageW: number;
  stageH: number;
  snapDist: number;
  pieces: Map<string, PieceInfo>;
  order: string[]; // piece ids in row-major order
  initialGroups: PieceGroup[];
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

  const stageW = Math.max(360, containerW);
  // Fill most of the viewport height so the play area uses the whole window.
  const viewportH = typeof window !== "undefined" ? window.innerHeight : 800;
  const stageH = Math.max(520, Math.floor(viewportH - 210));

  // The assembled picture takes ~40% of the width (capped in height), leaving
  // the rest of the (now full-window) area to spread and assemble pieces.
  let boardW = stageW * 0.4;
  let boardH = boardW / aspect;
  const maxBoardH = Math.min(460, stageH * 0.6);
  if (boardH > maxBoardH) {
    boardH = maxBoardH;
    boardW = boardH * aspect;
  }
  const pieceW = boardW / cols;
  const pieceH = boardH / rows;
  const tabV = TAB_FRAC * pieceW;
  const tabH = TAB_FRAC * pieceH;

  const grid = generateEdges(cols, rows, seed);
  const rng = mulberry32(seed ^ 0x9e3779b9);

  const boxW = pieceW + 2 * tabV;
  const boxH = pieceH + 2 * tabH;

  const pieces = new Map<string, PieceInfo>();
  const order: string[] = [];
  const initialGroups: PieceGroup[] = [];
  let gid = 1;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const id = `${r}-${c}`;
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(boxW);
      canvas.height = Math.ceil(boxH);
      const ctx = canvas.getContext("2d")!;
      const path = new Path2D(pieceOutlinePath(grid, r, c, pieceW, pieceH));

      ctx.save();
      ctx.translate(tabV, tabH);
      ctx.clip(path);
      ctx.drawImage(image, -c * pieceW, -r * pieceH, boardW, boardH);
      ctx.restore();

      ctx.save();
      ctx.translate(tabV, tabH);
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(0,0,0,0.35)";
      ctx.stroke(path);
      ctx.restore();

      const solvedX = c * pieceW;
      const solvedY = r * pieceH;

      // Scatter each single-piece group so its cell corner lands somewhere in
      // the stage; group origin = scattered corner minus the piece's solved
      // corner, keeping the shared puzzle coordinate frame intact.
      const cornerX = tabV + 6 + rng() * Math.max(1, stageW - boxW - 12);
      const cornerY = tabH + 6 + rng() * Math.max(1, stageH - boxH - 12);

      pieces.set(id, {
        id,
        row: r,
        col: c,
        canvas,
        offsetX: tabV,
        offsetY: tabH,
        solvedX,
        solvedY,
      });
      order.push(id);
      initialGroups.push({
        id: gid++,
        x: cornerX - solvedX,
        y: cornerY - solvedY,
        members: [id],
      });
    }
  }

  const snapDist = Math.max(18, 0.4 * Math.min(pieceW, pieceH));

  return { pieceW, pieceH, stageW, stageH, snapDist, pieces, order, initialGroups };
}

interface Props {
  puzzle: PuzzleData;
  onProgress: (groups: number, total: number) => void;
  onSolved: () => void;
}

export default function PuzzleBoard({ puzzle, onProgress, onSolved }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [containerW, setContainerW] = useState(0);
  const image = useHtmlImage(`/api/image/${puzzle.imageKey}`);

  // Group model lives in refs (mutated imperatively on drag); a version counter
  // triggers re-render only when membership/positions actually change.
  const groupsRef = useRef<Map<number, PieceGroup>>(new Map());
  const pieceToGroupRef = useRef<Map<string, number>>(new Map());
  const [, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const total = puzzle.cols * puzzle.rows;

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

  // Seed the group model whenever the layout is (re)built.
  useEffect(() => {
    if (!layout) return;
    const groups = new Map<number, PieceGroup>();
    const p2g = new Map<string, number>();
    for (const g of layout.initialGroups) {
      groups.set(g.id, { ...g, members: [...g.members] });
      for (const m of g.members) p2g.set(m, g.id);
    }
    groupsRef.current = groups;
    pieceToGroupRef.current = p2g;
    bump();
    onProgress(groups.size, total);
  }, [layout, total, onProgress, bump]);

  function handleGroupDragEnd(groupId: number, node: Konva.Node) {
    const groups = groupsRef.current;
    const p2g = pieceToGroupRef.current;

    const start = groups.get(groupId);
    if (!start) return;
    start.x = node.x();
    start.y = node.y();

    resolveConnections(groups, p2g, groupId, puzzle.rows, puzzle.cols, layout!.snapDist);

    bump();
    onProgress(groups.size, total);
    if (groups.size === 1) onSolved();
  }

  const groupList = Array.from(groupsRef.current.values());

  return (
    <div ref={wrapRef} className="board-wrap" style={{ width: "100%" }}>
      {layout && (
        <Stage width={layout.stageW} height={layout.stageH}>
          <Layer>
            {groupList.map((g) => (
              <Group
                key={g.id}
                x={g.x}
                y={g.y}
                draggable
                onDragStart={(e) => e.currentTarget.moveToTop()}
                onDragEnd={(e) => handleGroupDragEnd(g.id, e.currentTarget)}
                onMouseEnter={(e) => {
                  const stage = e.target.getStage();
                  if (stage) stage.container().style.cursor = "grab";
                }}
                onMouseLeave={(e) => {
                  const stage = e.target.getStage();
                  if (stage) stage.container().style.cursor = "default";
                }}
              >
                {g.members.map((pid) => {
                  const info = layout.pieces.get(pid)!;
                  return (
                    <KImage
                      key={pid}
                      image={info.canvas}
                      x={info.solvedX}
                      y={info.solvedY}
                      offsetX={info.offsetX}
                      offsetY={info.offsetY}
                    />
                  );
                })}
              </Group>
            ))}
          </Layer>
        </Stage>
      )}
    </div>
  );
}
