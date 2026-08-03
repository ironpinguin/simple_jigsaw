"use client";

import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import type { PieceGroup } from "@/lib/puzzle/groups";
import type { Rect } from "@/lib/puzzle/board";
import { groupMarkers, minimapSize, visibleRect } from "@/lib/puzzle/minimap";
import type { ViewSource } from "./viewStore";

/** Largest thumbnail, in CSS pixels; the CSS caps it again on narrow screens. */
const MAX_W = 190;
const MAX_H = 150;

/** Smallest marker on the thumbnail, in thumbnail pixels. */
const MIN_MARKER = 2.5;

/** How far one arrow key pans, as a fraction of the visible area. */
const PAN_STEP = 0.25;

const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/**
 * The board overview: the whole stage as a thumbnail, every group on it, and the
 * part of it currently on screen. Clicking, dragging or arrowing inside it
 * centres the stage on that spot, so a solver can reach a corner of the board
 * without panning blindly.
 *
 * Plain SVG rather than a second Konva stage: there is no bitmap to draw, and a
 * `viewBox` of the stage rectangle means every coordinate here is a *stage*
 * coordinate — the browser does the scaling, and none of the drawing has to
 * repeat the geometry the board already owns.
 */
export default function BoardMinimap({
  store,
  stageW,
  stageH,
  groups,
  rectOf,
  onJump,
}: {
  store: ViewSource;
  stageW: number;
  stageH: number;
  /** Back to front, as the board draws them — largest groups first. */
  groups: PieceGroup[];
  rectOf: (id: string) => Rect | undefined;
  /** Centre the stage on this stage coordinate. */
  onJump: (centre: { x: number; y: number }) => void;
}) {
  const t = useTranslations("solve");
  const view = useSyncExternalStore(store.subscribe, store.get, store.get);
  /** The pointer currently panning, so a second finger cannot end its drag. */
  const panning = useRef<number | null>(null);

  const size = useMemo(() => minimapSize(stageW, stageH, MAX_W, MAX_H), [stageW, stageH]);

  // Memoised as elements, not just as data: panning re-renders this component
  // on every frame, and an identical element lets React bail out of the whole
  // subtree instead of diffing one rect per group. It holds only because a pan
  // re-renders this component *without* re-rendering the board — `groupList`
  // (PuzzleBoard) is a fresh array on every board render, which is what makes
  // the markers follow a drop.
  const markers = useMemo(
    () => (
      <g>
        {/* `MIN_MARKER` is a thumbnail length; `groupMarkers` works in stage
            units, hence the division. The guard matters: this body runs before
            the zero-size early return below, where the ratio is `Infinity`. */}
        {groupMarkers(groups, rectOf, size.scale > 0 ? MIN_MARKER / size.scale : 0).map((m) => (
          <rect
            key={m.id}
            className={m.count > 1 ? "marker joined" : "marker"}
            x={m.x}
            y={m.y}
            width={m.width}
            height={m.height}
          />
        ))}
      </g>
    ),
    [groups, rectOf, size.scale],
  );

  const centre = useCallback(
    (point: { x: number; y: number }) => {
      // `onJump` is documented to take a point *on* the stage, so a drag past
      // the thumbnail's edge is clamped rather than passed through.
      // `stagePositionFor` saturates to the same view either way — this keeps
      // the contract honest at the boundary, it is not what makes the edge
      // slide.
      onJump({
        x: Math.min(stageW, Math.max(0, point.x)),
        y: Math.min(stageH, Math.max(0, point.y)),
      });
    },
    [onJump, stageW, stageH],
  );

  /**
   * Centre the board on the pointer, converting its client position to stage
   * coordinates. Does nothing before the thumbnail has been laid out, where the
   * conversion would be `NaN` and would blank the board.
   */
  const jumpToPointer = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const box = e.currentTarget.getBoundingClientRect();
      if (!box.width || !box.height) return;
      centre({
        x: ((e.clientX - box.left) / box.width) * stageW,
        y: ((e.clientY - box.top) / box.height) * stageH,
      });
    },
    [centre, stageW, stageH],
  );

  function handleKeyDown(e: React.KeyboardEvent<SVGSVGElement>) {
    const step = ARROWS[e.key];
    if (!step) return;
    e.preventDefault();
    const visible = visibleRect(view, stageW, stageH);
    centre({
      x: visible.x + visible.width * (0.5 + step[0] * PAN_STEP),
      y: visible.y + visible.height * (0.5 + step[1] * PAN_STEP),
    });
  }

  if (size.scale === 0) return null;

  const visible = visibleRect(view, stageW, stageH);

  return (
    <svg
      className="minimap"
      width={size.width}
      height={size.height}
      viewBox={`0 0 ${stageW} ${stageH}`}
      // Focusable and arrow-key pannable: the board has no other keyboard way to
      // move the view, so a pointer-only overview would make the corners of a
      // zoomed-in board unreachable without a mouse.
      tabIndex={0}
      // `application`, not `img`: a screen reader keeps the virtual cursor over
      // a graphic and swallows the arrow keys, which would leave the one
      // keyboard path off a mouse exactly where it is needed least.
      role="application"
      aria-label={t("minimap")}
      onKeyDown={handleKeyDown}
      onPointerDown={(e) => {
        // Panning is the primary button's job. Without this a right-click both
        // jumps the board and starts a drag the context menu then swallows.
        if (e.button !== 0) return;
        // Suppresses the text selection a drag across the thumbnail would
        // otherwise start — and, with it, the focus a click normally gives, so
        // the arrow keys stay dead after clicking unless focus is taken here.
        e.preventDefault();
        e.currentTarget.focus();
        panning.current = e.pointerId;
        // Jump before capturing: `setPointerCapture` throws on a pointer id the
        // element no longer sees, and losing the capture must not also lose the
        // click that asked for it.
        jumpToPointer(e);
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (panning.current !== e.pointerId) return;
        // A move with no button held ends the drag, whichever terminating event
        // went missing — a context menu, a window blur or a lost capture can
        // each swallow the `pointerup`, and capture suppresses `pointerleave`,
        // so every event-shaped fallback has a hole. This one cannot.
        if (e.buttons === 0) {
          panning.current = null;
          return;
        }
        jumpToPointer(e);
      }}
      onPointerUp={(e) => {
        if (panning.current !== e.pointerId) return;
        panning.current = null;
        e.currentTarget.releasePointerCapture?.(e.pointerId);
      }}
      onPointerCancel={(e) => {
        if (panning.current === e.pointerId) panning.current = null;
      }}
    >
      {markers}
      <rect
        className="viewport"
        x={visible.x}
        y={visible.y}
        width={visible.width}
        height={visible.height}
        // The viewBox scales the stage down by roughly an order of magnitude,
        // so an outline in user units would be a fraction of a pixel wide.
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
