"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Stage, Layer, Group, Image as KImage } from "react-konva";
import type Konva from "konva";
import { generateEdges } from "@/lib/puzzle/edges";
import { pieceOutlinePath } from "@/lib/puzzle/outline";
import {
  pieceId,
  renderOrder,
  resolveConnections,
  type PieceGroup,
} from "@/lib/puzzle/groups";
import {
  clampGroupPosition,
  pieceBox,
  scatterGroups,
  unionRect,
  type Rect,
} from "@/lib/puzzle/board";

export interface PuzzleData {
  id: string;
  imageKey: string;
  imageWidth: number;
  imageHeight: number;
  /** The creator's default piece count (the solver may pick another). */
  pieceCount: number;
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
  /** The bitmap's area in group coordinates; also its (rectangular) hit area. */
  rect: Rect;
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
  cols: number,
  rows: number,
): Layout {
  const { seed } = puzzle;
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

  const grid = generateEdges(cols, rows, seed);

  const pieces = new Map<string, PieceInfo>();
  const order: string[] = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const id = pieceId(r, c);
      const box = pieceBox(grid, r, c, pieceW, pieceH);

      const canvas = document.createElement("canvas");
      canvas.width = box.canvasW;
      canvas.height = box.canvasH;
      const ctx = canvas.getContext("2d")!;
      const path = new Path2D(pieceOutlinePath(grid, r, c, pieceW, pieceH));

      ctx.translate(box.offsetX, box.offsetY);

      // Clip to the piece and paint the corresponding region of the board.
      ctx.save();
      ctx.clip(path);
      ctx.drawImage(image, -c * pieceW, -r * pieceH, boardW, boardH);

      // Beveled cardboard edge: two directional INNER shadows (still clipped to
      // the piece) — a soft dark rim toward the bottom-right and a lighter rim
      // toward the top-left. The thin stroke casts a blurred shadow that only
      // survives on the inside of the clip, giving a rounded, raised edge.
      ctx.lineWidth = 1;
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.55)";
      ctx.shadowBlur = 7;
      ctx.shadowOffsetX = 3;
      ctx.shadowOffsetY = 3;
      ctx.strokeStyle = "rgba(0,0,0,0.55)";
      ctx.stroke(path);
      ctx.restore();
      ctx.save();
      ctx.shadowColor = "rgba(255,255,255,0.8)";
      ctx.shadowBlur = 6;
      ctx.shadowOffsetX = -3;
      ctx.shadowOffsetY = -3;
      ctx.strokeStyle = "rgba(255,255,255,0.7)";
      ctx.stroke(path);
      ctx.restore();
      ctx.restore(); // unclip

      // Crisp thin outline on top for a clean cut definition.
      ctx.save();
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(0,0,0,0.4)";
      ctx.stroke(path);
      ctx.restore();

      pieces.set(id, {
        id,
        row: r,
        col: c,
        canvas,
        offsetX: box.offsetX,
        offsetY: box.offsetY,
        solvedX: c * pieceW,
        solvedY: r * pieceH,
        rect: box.rect,
      });
      order.push(id);
    }
  }

  const snapDist = Math.max(18, 0.4 * Math.min(pieceW, pieceH));
  const initialGroups = scatterGroups({ cols, rows, seed, pieceW, pieceH, stageW, stageH });

  return { pieceW, pieceH, stageW, stageH, snapDist, pieces, order, initialGroups };
}

interface Props {
  puzzle: PuzzleData;
  cols: number;
  rows: number;
  onProgress: (groups: number, total: number) => void;
  onSolved: () => void;
}

export default function PuzzleBoard({ puzzle, cols, rows, onProgress, onSolved }: Props) {
  const t = useTranslations("solve");
  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const [containerW, setContainerW] = useState(0);
  const image = useHtmlImage(`/api/image/${puzzle.imageKey}`);

  // Group model lives in refs (mutated imperatively on drag); a version counter
  // triggers re-render only when membership/positions actually change.
  const groupsRef = useRef<Map<number, PieceGroup>>(new Map());
  const pieceToGroupRef = useRef<Map<string, number>>(new Map());
  const [, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  // The group being dragged, so it can be drawn on top declaratively (see
  // renderOrder). Konva's own moveToTop() would outlive the drag, because
  // react-konva reorders nodes only when the React child order changes.
  const [draggingId, setDraggingId] = useState<number | null>(null);

  const total = cols * rows;

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
    return buildLayout(puzzle, image, containerW, cols, rows);
  }, [image, containerW, puzzle, cols, rows]);

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

  /** A group's extent in its own coordinates — the input for the drag bounds. */
  function extentOf(g: PieceGroup, pieces: Layout["pieces"]): Rect {
    return unionRect(
      g.members
        .map((pid) => pieces.get(pid)?.rect)
        .filter((r): r is Rect => r !== undefined),
    );
  }

  function handleGroupDragEnd(groupId: number, node: Konva.Node) {
    setDraggingId(null);

    const groups = groupsRef.current;
    const p2g = pieceToGroupRef.current;

    const start = groups.get(groupId);
    if (!start) return;
    start.x = node.x();
    start.y = node.y();

    const { survivorId } = resolveConnections(groups, p2g, groupId, rows, cols, layout!.snapDist);

    // Merging keeps the survivor's origin but grows its extent, so a block
    // joined at the edge can reach past the stage by up to snapDist. Pull it
    // back in — the whole assembly shifts rigidly, connections are membership.
    const survivor = groups.get(survivorId);
    if (survivor) {
      const bounded = clampGroupPosition(
        { x: survivor.x, y: survivor.y },
        extentOf(survivor, layout!.pieces),
        layout!.stageW,
        layout!.stageH,
      );
      survivor.x = bounded.x;
      survivor.y = bounded.y;
    }

    bump();
    onProgress(groups.size, total);
    if (groups.size === 1) onSolved();
  }

  // --- Zoom & pan -----------------------------------------------------------
  const MIN_SCALE = 0.35;
  const MAX_SCALE = 3;

  const zoomAround = useCallback((nextScale: number, center: { x: number; y: number }) => {
    const stage = stageRef.current;
    if (!stage) return;
    const old = stage.scaleX();
    const s = Math.max(MIN_SCALE, Math.min(MAX_SCALE, nextScale));
    // Keep the point under `center` fixed while scaling.
    const anchor = { x: (center.x - stage.x()) / old, y: (center.y - stage.y()) / old };
    stage.scale({ x: s, y: s });
    stage.position({ x: center.x - anchor.x * s, y: center.y - anchor.y * s });
    stage.batchDraw();
  }, []);

  const handleWheel = useCallback(
    (e: Konva.KonvaEventObject<WheelEvent>) => {
      e.evt.preventDefault();
      const stage = stageRef.current;
      const pointer = stage?.getPointerPosition();
      if (!stage || !pointer) return;
      const factor = e.evt.deltaY > 0 ? 1 / 1.12 : 1.12;
      zoomAround(stage.scaleX() * factor, pointer);
    },
    [zoomAround],
  );

  const zoomButton = useCallback(
    (factor: number) => {
      const stage = stageRef.current;
      if (!stage) return;
      zoomAround(stage.scaleX() * factor, { x: stage.width() / 2, y: stage.height() / 2 });
    },
    [zoomAround],
  );

  const resetView = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    stage.scale({ x: 1, y: 1 });
    stage.position({ x: 0, y: 0 });
    stage.batchDraw();
  }, []);

  // Pinch-to-zoom (two fingers). Pauses stage panning while pinching.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !layout) return;
    const container = stage.container();
    let lastDist = 0;
    const dist = (t: TouchList) =>
      Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onMove = (e: TouchEvent) => {
      if (e.touches.length < 2) return;
      e.preventDefault();
      stage.draggable(false);
      const rect = container.getBoundingClientRect();
      const center = {
        x: (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left,
        y: (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top,
      };
      const d = dist(e.touches);
      if (lastDist) zoomAround(stage.scaleX() * (d / lastDist), center);
      lastDist = d;
    };
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) {
        lastDist = 0;
        stage.draggable(true);
      }
    };
    container.addEventListener("touchmove", onMove, { passive: false });
    container.addEventListener("touchend", onEnd);
    return () => {
      container.removeEventListener("touchmove", onMove);
      container.removeEventListener("touchend", onEnd);
    };
  }, [zoomAround, layout]);

  // Largest groups at the back, so loose pieces are never buried under an
  // assembled block (Konva hit-tests bitmaps by their full rectangle).
  const groupList = renderOrder(groupsRef.current.values(), draggingId);

  return (
    <div ref={wrapRef} className="board-wrap" style={{ width: "100%", position: "relative" }}>
      {layout && (
        <>
          <div className="zoom-controls">
            <button type="button" aria-label={t("zoomIn")} onClick={() => zoomButton(1.25)}>
              +
            </button>
            <button type="button" aria-label={t("zoomOut")} onClick={() => zoomButton(1 / 1.25)}>
              −
            </button>
            <button type="button" aria-label={t("resetView")} onClick={resetView}>
              ⟲
            </button>
          </div>
          <Stage
            ref={stageRef}
            width={layout.stageW}
            height={layout.stageH}
            draggable
            onWheel={handleWheel}
          >
            <Layer>
            {groupList.map((g) => {
              // Constant for as long as the group's membership is — computing it
              // per render keeps it out of the per-mousemove drag bound.
              const extent = extentOf(g, layout.pieces);
              return (
              <Group
                key={g.id}
                x={g.x}
                y={g.y}
                draggable
                // Konva hands us an absolute (screen) position; the play area is
                // defined in stage content coordinates, so undo the current
                // pan/zoom before clamping and reapply it afterwards.
                dragBoundFunc={(pos) => {
                  const stage = stageRef.current;
                  if (!stage) return pos;
                  const s = stage.scaleX() || 1;
                  const clamped = clampGroupPosition(
                    { x: (pos.x - stage.x()) / s, y: (pos.y - stage.y()) / s },
                    extent,
                    layout.stageW,
                    layout.stageH,
                  );
                  return { x: clamped.x * s + stage.x(), y: clamped.y * s + stage.y() };
                }}
                onDragStart={() => setDraggingId(g.id)}
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
                  // The group model is reseeded in an effect after `layout`
                  // rebuilds (e.g. on a piece-count change); skip stale ids for
                  // the one render in between.
                  const info = layout.pieces.get(pid);
                  if (!info) return null;
                  return (
                    <KImage
                      key={pid}
                      image={info.canvas}
                      x={info.solvedX}
                      y={info.solvedY}
                      offsetX={info.offsetX}
                      offsetY={info.offsetY}
                      shadowColor="#000"
                      shadowBlur={5}
                      shadowOpacity={0.35}
                      shadowOffsetX={2}
                      shadowOffsetY={3}
                    />
                  );
                })}
              </Group>
              );
            })}
            </Layer>
          </Stage>
        </>
      )}
    </div>
  );
}
