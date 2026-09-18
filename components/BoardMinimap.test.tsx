import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "@/messages/en.json";
import { pieceId, type PieceGroup } from "@/lib/puzzle/groups";
import type { Rect } from "@/lib/puzzle/board";
import { minimapSize, stagePositionFor, visibleRect } from "@/lib/puzzle/minimap";
import BoardMinimap from "./BoardMinimap";
import { createViewStore, type ViewStore } from "./viewStore";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STAGE_W = 1200;
const STAGE_H = 800;

/** Every piece is a 20×20 bitmap sitting on its own cell corner. */
const PIECE = 20;
const rectOf = (id: string): Rect | undefined => {
  const [row, col] = id.split("-").map(Number);
  return { x: col * PIECE, y: row * PIECE, width: PIECE, height: PIECE };
};

const group = (id: number, x: number, y: number, members: string[]): PieceGroup => ({
  id,
  x,
  y,
  members,
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mount(
  store: ViewStore,
  groups: PieceGroup[] = [group(1, 0, 0, [pieceId(0, 0)])],
  // Typed as the prop itself: defaulting to `vi.fn()` alone infers Mock<Procedure>,
  // which then rejects the plain callback `wired()` passes.
  onJump: (centre: { x: number; y: number }) => void = vi.fn(),
) {
  act(() => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <BoardMinimap
          store={store}
          stageW={STAGE_W}
          stageH={STAGE_H}
          groups={groups}
          rectOf={rectOf}
          onJump={onJump}
        />
      </NextIntlClientProvider>,
    );
  });
  return onJump;
}

const svg = () => container.querySelector("svg")!;
const viewport = () => container.querySelector<SVGRectElement>("rect.viewport")!;
const markers = () => [...container.querySelectorAll<SVGRectElement>("rect.marker")];
const num = (el: SVGRectElement, attr: string) => Number(el.getAttribute(attr));

/**
 * jsdom lays nothing out, so the element the pointer maths reads has no size.
 * Deliberately *not* the stage's 3:2 — with a matching ratio the two axes scale
 * by the same factor and a swapped width/height is invisible. The non-zero
 * left/top catch a dropped origin subtraction.
 */
const THUMB = { left: 40, top: 100, width: 180, height: 90 };
function layOut() {
  vi.spyOn(svg(), "getBoundingClientRect").mockReturnValue({
    ...THUMB,
    right: THUMB.left + THUMB.width,
    bottom: THUMB.top + THUMB.height,
    x: THUMB.left,
    y: THUMB.top,
    toJSON: () => "",
  });
}

/**
 * A pointer event at a fraction of the way across the thumbnail. `buttons`
 * defaults to the primary button being held, which is what a real drag reports;
 * pass 0 for a hover.
 */
function pointer(
  type: string,
  fx: number,
  fy: number,
  { pointerId = 1, button = 0, buttons = 1 } = {},
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, {
    pointerId,
    button,
    buttons,
    clientX: THUMB.left + fx * THUMB.width,
    clientY: THUMB.top + fy * THUMB.height,
  });
  act(() => {
    svg().dispatchEvent(event);
  });
}

describe("the overview drawing", () => {
  it("spans the whole stage, so its coordinates are stage coordinates", () => {
    mount(createViewStore());
    expect(svg().getAttribute("viewBox")).toBe(`0 0 ${STAGE_W} ${STAGE_H}`);
  });

  it("marks every group where it lies on the board", () => {
    mount(createViewStore(), [
      group(1, 300, 200, [pieceId(1, 2)]),
      group(2, 0, 0, [pieceId(0, 0), pieceId(0, 1)]),
    ]);
    const [first, second] = markers();
    expect([num(first, "x"), num(first, "y")]).toEqual([340, 220]);
    expect(num(second, "width")).toBe(2 * PIECE);
  });

  it("distinguishes an assembled block from a loose piece", () => {
    mount(createViewStore(), [
      group(1, 0, 0, [pieceId(0, 0)]),
      group(2, 100, 0, [pieceId(0, 0), pieceId(0, 1)]),
    ]);
    expect(markers().map((m) => m.getAttribute("class"))).toEqual(["marker", "marker joined"]);
  });

  it("covers the whole board with the viewport indicator at rest", () => {
    mount(createViewStore());
    expect(num(viewport(), "width")).toBe(STAGE_W);
    expect(num(viewport(), "height")).toBe(STAGE_H);
  });

  it("follows the stage when it is panned and zoomed outside React", () => {
    const store = createViewStore();
    mount(store);
    act(() => store.set({ x: -600, y: -200, scale: 2 }));
    expect(num(viewport(), "x")).toBe(300);
    expect(num(viewport(), "y")).toBe(100);
    expect(num(viewport(), "width")).toBe(STAGE_W / 2);
  });

  it("is announced as the board overview, and as something operable", () => {
    // Not `img`: a screen reader would keep the virtual cursor over a graphic
    // and never deliver the arrow keys the label promises.
    mount(createViewStore());
    expect(svg().getAttribute("aria-label")).toBe(messages.solve.minimap);
    expect(svg().getAttribute("role")).toBe("application");
  });

  it("sizes the thumbnail to the stage's aspect ratio", () => {
    // Swapping width and height here would stretch every marker and hang the
    // thumbnail off the board; the mocked layout hides it from the pointer maths.
    mount(createViewStore());
    const { width, height, scale } = minimapSize(STAGE_W, STAGE_H, 190, 150);
    expect(Number(svg().getAttribute("width"))).toBe(width);
    expect(Number(svg().getAttribute("height"))).toBe(height);
    expect(scale).toBeLessThan(1);
  });

  it("follows the groups when the board reports a drop", () => {
    // The marker memo is the file's performance mechanism, so it is likely to be
    // edited; an empty dependency array would freeze the markers for the whole
    // game while the viewport rectangle kept moving.
    const store = createViewStore();
    const onJump = vi.fn();
    const at = (x: number) => [group(1, x, 0, [pieceId(0, 0)])];
    const render = (groups: PieceGroup[]) =>
      act(() => {
        root.render(
          <NextIntlClientProvider locale="en" messages={messages}>
            <BoardMinimap
              store={store}
              stageW={STAGE_W}
              stageH={STAGE_H}
              groups={groups}
              rectOf={rectOf}
              onJump={onJump}
            />
          </NextIntlClientProvider>,
        );
      });

    render(at(0));
    expect(num(markers()[0], "x")).toBe(0);
    render(at(500));
    expect(num(markers()[0], "x")).toBe(500);
  });

  it("keeps a sub-pixel marker visible, widening it in stage units", () => {
    // `MIN_MARKER` is a thumbnail length and `groupMarkers` works in stage
    // units, so the conversion divides by the scale. Multiplying instead would
    // shrink the marker — silently wrong, and only visible on a dense board.
    //
    // Today's largest preset still renders a piece at ~6 thumbnail px, so the
    // floor is dead code; this pins which way the conversion goes before some
    // future preset makes it live. Hence a piece far smaller than any real one.
    const tiny = 1;
    const onJump = vi.fn();
    act(() => {
      root.render(
        <NextIntlClientProvider locale="en" messages={messages}>
          <BoardMinimap
            store={createViewStore()}
            stageW={STAGE_W}
            stageH={STAGE_H}
            groups={[group(1, 0, 0, [pieceId(0, 0)])]}
            rectOf={() => ({ x: 0, y: 0, width: tiny, height: tiny })}
            onJump={onJump}
          />
        </NextIntlClientProvider>,
      );
    });

    const { scale } = minimapSize(STAGE_W, STAGE_H, 190, 150);
    expect(tiny * scale).toBeLessThan(2.5); // the floor really is engaged
    expect(num(markers()[0], "width") * scale).toBeCloseTo(2.5, 6);
  });

  it("renders nothing for a stage with no area", () => {
    const onJump = vi.fn();
    act(() => {
      root.render(
        <NextIntlClientProvider locale="en" messages={messages}>
          <BoardMinimap
            store={createViewStore()}
            stageW={0}
            stageH={0}
            groups={[]}
            rectOf={rectOf}
            onJump={onJump}
          />
        </NextIntlClientProvider>,
      );
    });
    expect(container.querySelector("svg")).toBeNull();
  });
});

describe("jumping to a region", () => {
  it("centres the board on the point that was clicked", () => {
    const onJump = mount(createViewStore());
    layOut();
    pointer("pointerdown", 0.25, 0.75);
    expect(onJump).toHaveBeenCalledWith({ x: STAGE_W * 0.25, y: STAGE_H * 0.75 });
  });

  it("keeps following a drag once it has started", () => {
    const onJump = mount(createViewStore());
    layOut();
    pointer("pointerdown", 0.5, 0.5);
    pointer("pointermove", 0.75, 0.5);
    expect(onJump).toHaveBeenLastCalledWith({ x: STAGE_W * 0.75, y: STAGE_H * 0.5 });
    expect(onJump).toHaveBeenCalledTimes(2);
  });

  it("ignores a pointer that is only passing over it", () => {
    const onJump = mount(createViewStore());
    layOut();
    pointer("pointermove", 0.75, 0.5);
    expect(onJump).not.toHaveBeenCalled();
  });

  it("stops following once the pointer is released", () => {
    const onJump = mount(createViewStore());
    layOut();
    pointer("pointerdown", 0.5, 0.5);
    pointer("pointerup", 0.5, 0.5);
    pointer("pointermove", 0.75, 0.5);
    expect(onJump).toHaveBeenCalledTimes(1);
  });

  it("clamps a drag that leaves the thumbnail to the board's edge", () => {
    const onJump = mount(createViewStore());
    layOut();
    pointer("pointerdown", 0.5, 0.5);
    pointer("pointermove", 1.4, -0.3);
    expect(onJump).toHaveBeenLastCalledWith({ x: STAGE_W, y: 0 });
  });

  it("ignores a secondary button", () => {
    // A right-click used to jump the board — and then the context menu ate the
    // pointerup, leaving the drag live.
    const onJump = mount(createViewStore());
    layOut();
    pointer("pointerdown", 0.25, 0.75, { button: 2, buttons: 2 });
    expect(onJump).not.toHaveBeenCalled();
  });

  it("ends the drag when a move arrives with no button held", () => {
    // The self-heal. A context menu, a window blur or a lost capture can each
    // swallow the pointerup, and pointer capture suppresses pointerleave — so
    // without this the overview keeps panning the board on a bare hover.
    const onJump = mount(createViewStore());
    layOut();
    pointer("pointerdown", 0.5, 0.5);
    pointer("pointermove", 0.75, 0.5, { buttons: 0 });
    pointer("pointermove", 0.9, 0.5, { buttons: 0 });
    expect(onJump).toHaveBeenCalledTimes(1); // the pointerdown, and nothing after
  });

  it("stops following after the pointer is cancelled", () => {
    const onJump = mount(createViewStore());
    layOut();
    pointer("pointerdown", 0.5, 0.5);
    pointer("pointercancel", 0.5, 0.5);
    pointer("pointermove", 0.75, 0.5);
    expect(onJump).toHaveBeenCalledTimes(1);
  });

  it("lets a second pointer neither steal nor end the first one's drag", () => {
    const onJump = mount(createViewStore());
    layOut();
    pointer("pointerdown", 0.5, 0.5);
    pointer("pointermove", 0.6, 0.5, { pointerId: 2 });
    expect(onJump).toHaveBeenCalledTimes(1);
    pointer("pointerup", 0.6, 0.5, { pointerId: 2 });
    pointer("pointermove", 0.75, 0.5);
    expect(onJump).toHaveBeenLastCalledWith({ x: STAGE_W * 0.75, y: STAGE_H * 0.5 });
  });

  it("takes focus, so the arrow keys work straight after a click", () => {
    // The pointerdown is prevented to stop a drag selecting text, which also
    // suppresses the focus a click would otherwise give.
    mount(createViewStore());
    layOut();
    pointer("pointerdown", 0.5, 0.5);
    expect(document.activeElement).toBe(svg());
  });

  it("does nothing while the thumbnail has no layout to measure against", () => {
    // Rather than jumping to NaN, which would blank the board.
    const onJump = mount(createViewStore());
    pointer("pointerdown", 0.5, 0.5);
    expect(onJump).not.toHaveBeenCalled();
  });
});

describe("the round trip through the board's geometry", () => {
  /**
   * `onJump` wired the way `PuzzleBoard` wires it. That composition is the part
   * no test reaches otherwise — `PuzzleBoard` needs a canvas jsdom lacks — and
   * it is where an argument in the wrong order or a scale read from the wrong
   * place would blank the board on every click of the overview.
   */
  function wired(scale: number) {
    const store = createViewStore({ x: 0, y: 0, scale });
    const onJump = (centre: { x: number; y: number }) =>
      act(() => {
        store.set({ ...stagePositionFor(centre, scale, STAGE_W, STAGE_H), scale });
      });
    mount(store, [group(1, 0, 0, [pieceId(0, 0)])], onJump);
    return store;
  }

  it("brings the clicked point to the middle of the view", () => {
    const store = wired(2);
    layOut();
    pointer("pointerdown", 0.25, 0.75);

    const visible = visibleRect(store.get(), STAGE_W, STAGE_H);
    expect(visible.x + visible.width / 2).toBeCloseTo(STAGE_W * 0.25, 6);
    expect(visible.y + visible.height / 2).toBeCloseTo(STAGE_H * 0.75, 6);
  });

  it("never leaves the view hanging off the board", () => {
    const store = wired(2);
    layOut();
    for (const [fx, fy] of [
      [0, 0],
      [1, 1],
      [0, 1],
      [1, 0],
    ]) {
      pointer("pointerdown", fx, fy);
      pointer("pointerup", fx, fy);
      const visible = visibleRect(store.get(), STAGE_W, STAGE_H);
      expect(visible.x).toBeGreaterThanOrEqual(0);
      expect(visible.y).toBeGreaterThanOrEqual(0);
      expect(visible.x + visible.width).toBeLessThanOrEqual(STAGE_W);
      expect(visible.y + visible.height).toBeLessThanOrEqual(STAGE_H);
    }
  });

  it("moves the viewport indicator to where the click landed", () => {
    // End to end: pointer → stage position → store → the drawn rectangle.
    wired(2);
    layOut();
    const before = num(viewport(), "x");
    pointer("pointerdown", 1, 0.5);
    expect(num(viewport(), "x")).toBeGreaterThan(before);
    expect(num(viewport(), "x") + num(viewport(), "width")).toBeCloseTo(STAGE_W, 6);
  });
});

describe("keyboard panning", () => {
  /** Zoomed in 2×, centred: the visible area is the middle half of the stage. */
  function zoomedIn() {
    const store = createViewStore();
    const onJump = mount(store);
    act(() => store.set({ x: -STAGE_W / 2, y: -STAGE_H / 2, scale: 2 }));
    return onJump;
  }

  // Centre is (600, 400) and the visible area 600×400, so a quarter step is 150
  // across and 100 down. All four are listed: with only two, an inverted entry
  // in the arrow table sends the view the wrong way and nothing notices.
  it.each([
    ["ArrowRight", { x: 750, y: 400 }],
    ["ArrowLeft", { x: 450, y: 400 }],
    ["ArrowDown", { x: 600, y: 500 }],
    ["ArrowUp", { x: 600, y: 300 }],
  ] as const)("moves the view a quarter of a screen on %s", (key, expected) => {
    const onJump = zoomedIn();
    act(() => {
      svg().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });
    expect(onJump).toHaveBeenCalledWith(expected);
  });

  it("leaves other keys to the page", () => {
    const onJump = zoomedIn();
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    act(() => {
      svg().dispatchEvent(event);
    });
    expect(onJump).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("is reachable by keyboard at all", () => {
    mount(createViewStore());
    expect(svg().getAttribute("tabindex")).toBe("0");
  });
});
