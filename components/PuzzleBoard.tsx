"use client";

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { Stage, Layer, Group, Image as KImage } from "react-konva";
import type Konva from "konva";
import { generateEdges, type EdgeGrid } from "@/lib/puzzle/edges";
import { pieceOutlinePath } from "@/lib/puzzle/outline";
import {
  pieceId,
  renderOrder,
  resolveConnections,
  type PieceGroup,
} from "@/lib/puzzle/groups";
import {
  boardGeometry,
  gatherLoose,
  pieceBox,
  scatterGroups,
  settleGroup,
  type BoardGeometry,
  type PieceBox,
  type Rect,
} from "@/lib/puzzle/board";
import { restoreSolveState, serialiseSolveState } from "@/lib/puzzle/solveState";
import { clampScale, wheelZoomFactor } from "@/lib/puzzle/zoom";
import { stagePositionFor } from "@/lib/puzzle/minimap";
import ZoomControls from "./ZoomControls";
import BoardMinimap from "./BoardMinimap";
import { createViewStore } from "./viewStore";

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

/**
 * Rasterise one piece into its own bitmap: the board image clipped to the
 * piece's outline, plus the shading that makes it read as cardboard. This is the
 * only canvas work in the file, which is what keeps `lib/puzzle` — including the
 * `pieceBox` geometry it sizes itself from — testable in plain node.
 */
function renderPieceCanvas(
  image: HTMLImageElement,
  grid: EdgeGrid,
  box: PieceBox,
  row: number,
  col: number,
  { pieceW, pieceH, boardW, boardH }: BoardGeometry,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = box.canvasW;
  canvas.height = box.canvasH;
  const ctx = canvas.getContext("2d")!;
  const path = new Path2D(pieceOutlinePath(grid, row, col, pieceW, pieceH));

  ctx.translate(box.offsetX, box.offsetY);

  // Clip to the piece and paint the corresponding region of the board.
  ctx.save();
  ctx.clip(path);
  ctx.drawImage(image, -col * pieceW, -row * pieceH, boardW, boardH);

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

  return canvas;
}

/**
 * Fallback when there is nothing to measure: server rendering, or a test that
 * mounts the board outside the site layout. Equivalent to the old fixed budget on
 * an 800px window, and the stage floor takes over below it anyway.
 */
const FALLBACK_AVAILABLE_H = 590;

/**
 * The height the stage can take without the page needing a scrollbar: the window
 * minus what sits above the board and what sits below it. Measured rather than
 * assumed — the budget used to be a constant here, and it went stale the moment a
 * site footer appeared below the board.
 *
 * Nothing in here depends on the board's current height, so the first call gets
 * the same answer as every later one, while the stage is still empty. That rules
 * out `documentElement.scrollHeight`, which `body { min-height: 100vh }` floors
 * at the viewport height and which would therefore report the whole empty page as
 * chrome. What is below the board is instead its `<main>`'s bottom padding plus
 * whatever follows that `<main>` — assuming, as the solve view does, that the
 * board is the last thing inside it.
 */
function availableBoardHeight(wrap: HTMLElement | null): number {
  if (typeof window === "undefined" || !wrap) return FALLBACK_AVAILABLE_H;
  const main = wrap.closest("main");
  if (!main) return FALLBACK_AVAILABLE_H;

  const topInDocument = wrap.getBoundingClientRect().top + window.scrollY;
  let below = parseFloat(getComputedStyle(main).paddingBottom) || 0;
  for (let el = main.nextElementSibling; el; el = el.nextElementSibling) {
    below += el.getBoundingClientRect().height;
  }
  // stageH is the canvas box; the wrapper's own border sits outside it.
  const wrapBorders = wrap.offsetHeight - wrap.clientHeight;

  return window.innerHeight - topInDocument - below - wrapBorders;
}

function buildLayout(
  puzzle: PuzzleData,
  image: HTMLImageElement,
  containerW: number,
  cols: number,
  rows: number,
  availableH: number,
): Layout {
  const { seed } = puzzle;

  const geo = boardGeometry({
    containerW,
    availableH,
    aspect: puzzle.imageWidth / puzzle.imageHeight,
    cols,
    rows,
  });
  const { stageW, stageH, pieceW, pieceH, snapDist } = geo;

  const grid = generateEdges(cols, rows, seed);

  const pieces = new Map<string, PieceInfo>();
  const order: string[] = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const id = pieceId(r, c);
      const box = pieceBox(grid, r, c, pieceW, pieceH);
      pieces.set(id, {
        id,
        row: r,
        col: c,
        canvas: renderPieceCanvas(image, grid, box, r, c, geo),
        offsetX: box.offsetX,
        offsetY: box.offsetY,
        solvedX: c * pieceW,
        solvedY: r * pieceH,
        rect: box.rect,
      });
      order.push(id);
    }
  }

  const initialGroups = scatterGroups({
    cols,
    rows,
    seed,
    stageW,
    stageH,
    rectOf: (id) => pieces.get(id)!.rect,
  });

  return { pieceW, pieceH, stageW, stageH, snapDist, pieces, order, initialGroups };
}

/** What the solver's toolbar can ask of the board. */
export interface BoardActions {
  /** Collect every loose piece into the area free of assemblies. */
  gatherLoose: () => void;
}

interface Props {
  puzzle: PuzzleData;
  cols: number;
  rows: number;
  /** `PuzzleSolver` owns the toggle. */
  showMinimap: boolean;
  onProgress: (groups: number, total: number) => void;
  onSolved: () => void;
  /**
   * The raw stored solve state to resume from, or `null` to scatter — the board
   * also scatters when a state is present but unusable. `PuzzleSolver` owns the
   * storage.
   *
   * A callback rather than a value so the board pulls it exactly when it seeds. As
   * a value prop, `startOver` would have to make the board tell "not read yet"
   * apart from "deliberately cleared"; re-reading on a `resetNonce` change needs
   * no such distinction. Must be referentially stable — it is a dependency of the
   * seeding effect.
   */
  loadSolveState: () => string | null;
  /**
   * Must not throw: this is called from a Konva `dragend` handler, where an error
   * escapes into Konva's event dispatch and no React error boundary can catch it.
   */
  saveSolveState: (raw: string) => void;
  /** Changes when the solver asks to start over; re-seeds from the scatter. */
  resetNonce: number;
  /**
   * Filled with the board's actions once it is mounted. A handle rather than a
   * nonce prop like `resetNonce`: gathering is a one-off command, and running it
   * from an effect would re-render the board from inside that effect.
   */
  actionsRef?: Ref<BoardActions | null>;
}

export default function PuzzleBoard({
  puzzle,
  cols,
  rows,
  showMinimap,
  onProgress,
  onSolved,
  loadSolveState,
  saveSolveState,
  resetNonce,
  actionsRef,
}: Props) {
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

  const viewStore = useMemo(() => createViewStore(), []);

  /** Call after every write to the stage transform — see `viewStore`. */
  const publishView = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    viewStore.set({ x: stage.x(), y: stage.y(), scale: stage.scaleX() });
  }, [viewStore]);

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
    // Measured here rather than inside buildLayout so lib/puzzle stays free of
    // the DOM. Like the container width it is read once, when the layout is
    // built: a later window resize does not re-lay-out the board.
    return buildLayout(puzzle, image, containerW, cols, rows, availableBoardHeight(wrapRef.current));
  }, [image, containerW, puzzle, cols, rows]);

  // Seed the group model whenever the layout is (re)built: resume the stored solve
  // if there is a usable one, otherwise scatter.
  //
  // The read belongs in an effect because it needs `layout` — which exists only
  // once the lazily imported chunk, the image and the container width have all
  // resolved — and because it has to run again whenever the layout is rebuilt or
  // `resetNonce` changes. (Not for hydration's sake: this component is imported
  // with `ssr: false`, so it never renders on the server. Issue #7 was about
  // `PuzzleSolver`, which does.)
  useEffect(() => {
    if (!layout) return;
    const { stageW, stageH } = layout;

    const restored = restoreSolveState(
      loadSolveState(),
      { cols, rows, stageW, stageH },
      (pid) => layout.pieces.get(pid)?.rect,
    );

    // Note the settled positions are deliberately not written back. Storage keeps
    // the fractions as they were saved, so each restore clamps from the original
    // rather than from the last clamp — otherwise a few resizes would walk a group
    // inward step by step.
    const groups = new Map<number, PieceGroup>();
    const p2g = new Map<string, number>();
    for (const g of restored ?? layout.initialGroups) {
      groups.set(g.id, { ...g, members: [...g.members] });
      for (const m of g.members) p2g.set(m, g.id);
    }
    groupsRef.current = groups;
    pieceToGroupRef.current = p2g;
    bump();
    onProgress(groups.size, total);
    // `resetNonce` is not read: it is a dependency so that starting over re-runs
    // this, finds the entry the solver has just deleted gone, and falls through to
    // a fresh scatter — even though the layout itself is unchanged. A `key` on the
    // component would do it too, but that remounts and re-rasterises every piece.
  }, [layout, cols, rows, total, onProgress, bump, loadSolveState, resetNonce]);

  /** Write the current group model to the solver's storage. */
  const persist = useCallback(
    (current: Layout) => {
      saveSolveState(
        serialiseSolveState({
          groups: groupsRef.current.values(),
          cols,
          rows,
          stageW: current.stageW,
          stageH: current.stageH,
          updatedAt: Date.now(),
        }),
      );
    },
    [saveSolveState, cols, rows],
  );

  const gather = useCallback(() => {
    if (!layout) return;
    const groups = groupsRef.current;
    const moved = gatherLoose({
      groups: groups.values(),
      stageW: layout.stageW,
      stageH: layout.stageH,
      rectOf: (pid) => layout.pieces.get(pid)?.rect,
    });
    if (moved.length === 0) return;
    for (const g of moved) groups.set(g.id, g);
    bump();
    persist(layout);
  }, [layout, bump, persist]);

  useImperativeHandle(actionsRef, () => ({ gatherLoose: gather }), [gather]);

  function handleGroupDragEnd(groupId: number, node: Konva.Node) {
    setDraggingId(null);

    // Read once instead of asserting at each use: a drag can only have started
    // from nodes this layout rendered, but an error thrown here escapes into
    // Konva's event dispatch, where no error boundary can catch it.
    const current = layout;
    if (!current) return;

    const groups = groupsRef.current;
    const p2g = pieceToGroupRef.current;

    const start = groups.get(groupId);
    if (!start) return;
    start.x = node.x();
    start.y = node.y();

    const { survivorId } = resolveConnections(groups, p2g, groupId, rows, cols, current.snapDist);

    // Dragging is unbounded so that a piece can always reach a neighbour parked
    // against an edge; the drop is what has to land on the board. A merge snaps
    // the survivor onto the stationary neighbour's origin AND unions the two
    // extents, so either can push the assembly past the edge. Moving the origin
    // shifts the whole assembly rigidly — connections are membership, not
    // positions — so pulling it back in cannot break a connection.
    // `resolveConnections` always returns a live id when given one.
    const survivor = groups.get(survivorId)!;
    const settled = settleGroup(
      survivor,
      (pid) => current.pieces.get(pid)?.rect,
      current.stageW,
      current.stageH,
    );
    if (settled) {
      survivor.x = settled.x;
      survivor.y = settled.y;
      // react-konva writes the x/y props only when they differ from the previous
      // render, and the node was moved by Konva behind React's back during the
      // drag. Settling onto the value last rendered would therefore be skipped
      // and leave the node where it was dropped — off the board, which is the
      // whole thing being fixed. Sync the dragged node explicitly.
      if (survivor.id === groupId) node.position({ x: survivor.x, y: survivor.y });
    }

    bump();
    onProgress(groups.size, total);
    if (groups.size === 1) onSolved();

    // Drops are far too rare for debouncing to buy anything. (The seeding effect
    // also replaces the model, and deliberately does not save — see there.)
    persist(current);
  }

  // --- Zoom & pan -----------------------------------------------------------

  const zoomAround = useCallback(
    (nextScale: number, center: { x: number; y: number }) => {
      const stage = stageRef.current;
      if (!stage) return;
      const old = stage.scaleX();
      const s = clampScale(nextScale);
      // Keep the point under `center` fixed while scaling.
      const anchor = { x: (center.x - stage.x()) / old, y: (center.y - stage.y()) / old };
      stage.scale({ x: s, y: s });
      stage.position({ x: center.x - anchor.x * s, y: center.y - anchor.y * s });
      stage.batchDraw();
      publishView();
    },
    [publishView],
  );

  const handleWheel = useCallback(
    (e: Konva.KonvaEventObject<WheelEvent>) => {
      e.evt.preventDefault();
      const stage = stageRef.current;
      const pointer = stage?.getPointerPosition();
      if (!stage || !pointer) return;
      zoomAround(stage.scaleX() * wheelZoomFactor(e.evt.deltaY, e.evt.deltaMode), pointer);
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
    publishView();
  }, [publishView]);

  /** Bring a point of the board — picked on the overview — into the middle. */
  const jumpTo = useCallback(
    (centre: { x: number; y: number }) => {
      const stage = stageRef.current;
      if (!stage || !layout) return;
      stage.position(stagePositionFor(centre, stage.scaleX(), layout.stageW, layout.stageH));
      stage.batchDraw();
      publishView();
    },
    [layout, publishView],
  );

  const rectOf = useCallback((pid: string) => layout?.pieces.get(pid)?.rect, [layout]);

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
          <ZoomControls
            store={viewStore}
            onZoomIn={() => zoomButton(1.25)}
            onZoomOut={() => zoomButton(1 / 1.25)}
            onReset={resetView}
          />
          {showMinimap && (
            <BoardMinimap
              store={viewStore}
              stageW={layout.stageW}
              stageH={layout.stageH}
              groups={groupList}
              rectOf={rectOf}
              onJump={jumpTo}
            />
          )}
          <Stage
            ref={stageRef}
            width={layout.stageW}
            height={layout.stageH}
            draggable
            onWheel={handleWheel}
            // Konva bubbles a group's drag events up to the stage, so the
            // target check is what tells a piece drag from a pan of the stage
            // itself. The store would discard a piece drag's publishes anyway —
            // the transform has not changed — but this keeps a drag from
            // reading the stage back on every frame.
            onDragMove={(e) => {
              if (e.target === stageRef.current) publishView();
            }}
            onDragEnd={(e) => {
              if (e.target === stageRef.current) publishView();
            }}
          >
            <Layer>
            {groupList.map((g) => (
              <Group
                key={g.id}
                x={g.x}
                y={g.y}
                draggable
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
            ))}
            </Layer>
          </Stage>
        </>
      )}
    </div>
  );
}
