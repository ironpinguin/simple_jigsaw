import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "@/messages/en.json";
import { pieceId, type PieceGroup } from "@/lib/puzzle/groups";
import type { Rect } from "@/lib/puzzle/board";
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
  onJump = vi.fn(),
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
 * The thumbnail's own aspect ratio keeps the two axes independent — a swapped
 * x/y would not survive it.
 */
const THUMB = { left: 40, top: 100, width: 180, height: 120 };
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

/** A pointer event at a fraction of the way across the thumbnail. */
function pointer(type: string, fx: number, fy: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, {
    pointerId: 1,
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

  it("is announced as the board overview", () => {
    mount(createViewStore());
    expect(svg().getAttribute("aria-label")).toBe(messages.solve.minimap);
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

describe("keyboard panning", () => {
  /** Zoomed in 2×, centred: the visible area is the middle half of the stage. */
  function zoomedIn() {
    const store = createViewStore();
    const onJump = mount(store);
    act(() => store.set({ x: -STAGE_W / 2, y: -STAGE_H / 2, scale: 2 }));
    return onJump;
  }

  it("moves the view by a quarter of what is on screen", () => {
    const onJump = zoomedIn();
    act(() => {
      svg().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    // Centre was (600, 400); a quarter of the visible 600×400 is 150 across.
    expect(onJump).toHaveBeenCalledWith({ x: 750, y: 400 });
  });

  it("moves the opposite way for the opposite key", () => {
    const onJump = zoomedIn();
    act(() => {
      svg().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    });
    expect(onJump).toHaveBeenCalledWith({ x: 600, y: 300 });
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
