import {
  Activity,
  act,
  createRef,
  useImperativeHandle,
  useRef,
  type ReactNode,
  type Ref,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "@/messages/en.json";
import { pieceId } from "@/lib/puzzle/groups";
import { deserialiseSolveState, serialiseSolveState } from "@/lib/puzzle/solveState";
import PuzzleBoard, { type BoardActions } from "./PuzzleBoard";

// jsdom has no canvas, so Konva cannot run here. What these tests are about is
// the React side of the board — seeding, the group model, drop handling, what it
// reports and saves — and none of that needs pixels. So react-konva is replaced
// by plain elements that carry the props the board passes, and the handlers are
// kept per element so a test can drop a group like Konva would.

interface GroupProps {
  x: number;
  y: number;
  onDragStart: () => void;
  onDragEnd: (e: { currentTarget: FakeNode }) => void;
  children?: ReactNode;
}

interface FakeNode {
  x(): number;
  y(): number;
  position(p?: { x: number; y: number }): void;
}

const groupProps = new WeakMap<Element, GroupProps>();

/** Every value the board has set the stage's `draggable` to, in order. */
const stageDraggable: boolean[] = [];

vi.mock("react-konva", () => {
  function Stage({
    children,
    ref,
    width,
    height,
  }: {
    children?: ReactNode;
    ref?: Ref<unknown>;
    width?: number;
    height?: number;
  }) {
    const el = useRef<HTMLDivElement>(null);
    // What the board uses of the stage outside the zoom controls: the pinch
    // effect listens on its container and pauses panning while pinching.
    useImperativeHandle(ref, () => ({
      container: () => el.current,
      draggable: (on: boolean) => {
        stageDraggable.push(on);
      },
    }));
    return (
      <div data-stage="" data-w={width} data-h={height} ref={el}>
        {children}
      </div>
    );
  }
  function Layer({ children }: { children?: ReactNode }) {
    return <div data-layer="">{children}</div>;
  }
  function Group(props: GroupProps) {
    return (
      <div
        data-group=""
        data-x={props.x}
        data-y={props.y}
        ref={(el) => {
          if (el) groupProps.set(el, props);
        }}
      >
        {props.children}
      </div>
    );
  }
  function Image({
    x,
    y,
    offsetX,
    offsetY,
    image,
  }: {
    x: number;
    y: number;
    offsetX: number;
    offsetY: number;
    image: HTMLCanvasElement;
  }) {
    return (
      <span
        data-piece=""
        data-x={x}
        data-y={y}
        data-ox={offsetX}
        data-oy={offsetY}
        data-w={image.width}
        data-h={image.height}
      />
    );
  }
  return { Stage, Layer, Group, Image };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const puzzle = {
  id: "p1",
  imageKey: "key.webp",
  imageWidth: 1200,
  imageHeight: 900,
  pieceCount: 12,
  seed: 7,
};
// computeGrid(12, 4/3) is 4 x 3.
const COLS = 4;
const ROWS = 3;

/** Canvas and image loading, just far enough for the board to build its layout. */
function stubBrowser() {
  const ctx = new Proxy({}, { get: () => () => {} });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D,
  );
  vi.stubGlobal("Path2D", class {});
  vi.stubGlobal(
    "Image",
    class {
      onload: (() => void) | null = null;
      crossOrigin = "";
      set src(_: string) {
        queueMicrotask(() => this.onload?.());
      }
    },
  );
  // jsdom has no ResizeObserver, and its layout gives every element a width of
  // 0 — so the board, finding no width on its wrapper, waits for one. This
  // observer reports straight away; a real one reports at the next rendering
  // update, which is why the board does not wait when there already is a width.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() {
        this.callback(
          [{ contentRect: { width: 1400 } } as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      }
      disconnect() {}
    },
  );
}

describe("PuzzleBoard", () => {
  let container: HTMLDivElement;
  let root: Root;
  let stored: string | null;
  let saved: string[];
  let onProgress: ReturnType<typeof vi.fn<(groups: number, total: number) => void>>;
  let onSolved: ReturnType<typeof vi.fn<() => void>>;
  const actions = createRef<BoardActions | null>();

  function board(resetNonce = 0, grid = { cols: COLS, rows: ROWS }) {
    return (
      <NextIntlClientProvider locale="en" messages={messages}>
        <PuzzleBoard
          puzzle={puzzle}
          cols={grid.cols}
          rows={grid.rows}
          showMinimap={false}
          onProgress={onProgress}
          onSolved={onSolved}
          loadSolveState={loadSolveState}
          saveSolveState={saveSolveState}
          resetNonce={resetNonce}
          actionsRef={actions}
        />
      </NextIntlClientProvider>
    );
  }
  // Stable, as the real solver's are: the board lists them as effect dependencies.
  const loadSolveState = () => stored;
  const saveSolveState = (raw: string) => {
    saved.push(raw);
  };

  async function mount(resetNonce = 0, grid = { cols: COLS, rows: ROWS }) {
    await act(async () => {
      root.render(board(resetNonce, grid));
    });
    // The image "loads" in a microtask; let the layout build and seed.
    await act(async () => {});
  }

  /** A number the board put on an element. A missing one fails rather than reading as 0. */
  function num(el: Element, name: string): number {
    const value = el.getAttribute(name);
    if (value === null) throw new Error(`${name} missing on ${el.outerHTML.slice(0, 80)}`);
    return Number(value);
  }

  /** The groups as rendered, each with its pieces' solved offsets and bitmaps. */
  function groups() {
    return [...container.querySelectorAll("[data-group]")].map((el) => ({
      el,
      x: num(el, "data-x"),
      y: num(el, "data-y"),
      pieces: [...el.querySelectorAll("[data-piece]")].map((p) => ({
        x: num(p, "data-x"),
        y: num(p, "data-y"),
        offsetX: num(p, "data-ox"),
        offsetY: num(p, "data-oy"),
        width: num(p, "data-w"),
        height: num(p, "data-h"),
      })),
    }));
  }

  type ShownGroup = ReturnType<typeof groups>[number];

  function stageSize() {
    const stage = container.querySelector("[data-stage]")!;
    return { w: num(stage, "data-w"), h: num(stage, "data-h") };
  }

  /** Where a group's bitmaps lie on the stage. */
  function extent(g: ShownGroup) {
    const left = g.pieces.map((p) => g.x + p.x - p.offsetX);
    const top = g.pieces.map((p) => g.y + p.y - p.offsetY);
    return {
      left: Math.min(...left),
      top: Math.min(...top),
      right: Math.max(...g.pieces.map((p, i) => left[i] + p.width)),
      bottom: Math.max(...g.pieces.map((p, i) => top[i] + p.height)),
    };
  }

  /** The group holding the top-left piece: every other group snaps onto its origin. */
  function anchor() {
    return groups().find((g) => g.pieces.some((p) => p.x === 0 && p.y === 0))!;
  }

  /**
   * The loose group next in reading order of its piece's solved position. The
   * anchor's assembly grows in that order, so this piece always borders it —
   * whatever order the groups happen to be drawn in.
   */
  function nextLoose() {
    const a = anchor();
    const [next] = groups()
      .filter((g) => g.el !== a.el)
      .sort((p, q) => p.pieces[0].y - q.pieces[0].y || p.pieces[0].x - q.pieces[0].x);
    return next;
  }

  /** A stand-in for the Konva node a drag handler is given, lying at `at`. */
  function fakeNode(at: { x: number; y: number }): FakeNode {
    let pos = { ...at };
    return {
      x: () => pos.x,
      y: () => pos.y,
      position: (p) => {
        if (p) pos = p;
      },
    };
  }

  /**
   * Drop `el`'s group at `to`, the way Konva reports the end of a drag. Returns
   * the dropped node, whose position the board may have moved.
   */
  async function drop(el: Element, to: { x: number; y: number }) {
    const props = groupProps.get(el)!;
    const node = fakeNode(to);
    await act(async () => props.onDragStart());
    await act(async () => props.onDragEnd({ currentTarget: node }));
    return node;
  }

  /** Drop the next loose piece onto the anchor, joining it to the assembly. */
  async function joinNext() {
    const a = anchor();
    await drop(nextLoose().el, { x: a.x, y: a.y });
  }

  /** Join every loose piece onto the anchor's assembly. */
  async function solve() {
    for (let guard = 0; guard < COLS * ROWS && groups().length > 1; guard++) await joinNext();
  }

  /** A save read back the way the board resumes one, against the stage it drew. */
  function readSave(raw: string) {
    const { w, h } = stageSize();
    return deserialiseSolveState(raw, { cols: COLS, rows: ROWS, stageW: w, stageH: h });
  }

  /** `raw` holds exactly the groups on the board, where they are drawn. */
  function expectSaveOfBoard(raw: string) {
    const unmatched = [...(readSave(raw) ?? [])];
    for (const g of groups()) {
      const i = unmatched.findIndex(
        (s) =>
          s.members.length === g.pieces.length &&
          Math.abs(s.x - g.x) < 1e-6 &&
          Math.abs(s.y - g.y) < 1e-6,
      );
      expect(i, `no saved group at (${g.x}, ${g.y})`).toBeGreaterThanOrEqual(0);
      unmatched.splice(i, 1);
    }
    expect(unmatched).toEqual([]);
  }

  beforeEach(() => {
    stubBrowser();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    stored = null;
    saved = [];
    stageDraggable.length = 0;
    onProgress = vi.fn();
    onSolved = vi.fn();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("scatters one group per piece when nothing is stored", async () => {
    await mount();

    expect(groups()).toHaveLength(COLS * ROWS);
    expect(groups().every((g) => g.pieces.length === 1)).toBe(true);
    expect(onProgress).toHaveBeenLastCalledWith(COLS * ROWS, COLS * ROWS);
    expect(saved).toEqual([]); // seeding does not save
  });

  it("builds from the wrapper's own width, without waiting for the resize observer", async () => {
    // A page in a background tab gets no ResizeObserver notifications until it
    // is shown. The board still has to be laid out by then.
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1400);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    await mount();

    expect(groups()).toHaveLength(COLS * ROWS);
    expect(stageSize().w).toBe(1400);
  });

  it("resumes a stored solve", async () => {
    // A state with the whole top row already joined.
    const members = (r: number) => Array.from({ length: COLS }, (_, c) => pieceId(r, c));
    const pieces = [
      { id: 1, x: 10, y: 10, members: members(0) },
      ...[1, 2].flatMap((r) =>
        Array.from({ length: COLS }, (_, c) => ({
          id: 10 + r * COLS + c,
          x: 50 + c * 90,
          y: 300 + r * 90,
          members: [pieceId(r, c)],
        })),
      ),
    ];
    stored = serialiseSolveState({
      groups: pieces,
      cols: COLS,
      rows: ROWS,
      stageW: 1400,
      stageH: 590,
      updatedAt: 1,
    });
    await mount();

    expect(groups()).toHaveLength(1 + 2 * COLS);
    expect(Math.max(...groups().map((g) => g.pieces.length))).toBe(COLS);
    expect(onProgress).toHaveBeenLastCalledWith(1 + 2 * COLS, COLS * ROWS);
  });

  it("joins a piece dropped onto its neighbour, and saves the result", async () => {
    await mount();

    await joinNext();

    expect(groups()).toHaveLength(COLS * ROWS - 1);
    expect(onProgress).toHaveBeenLastCalledWith(COLS * ROWS - 1, COLS * ROWS);
    expect(saved).toHaveLength(1);
    // Read back the way a reload would, so a save the board could not resume fails.
    expect(readSave(saved[0])?.some((g) => g.members.length === 2)).toBe(true);
    expectSaveOfBoard(saved[0]);
  });

  it("leaves a piece dropped far from any neighbour on its own, where it was dropped", async () => {
    await mount();
    const mover = nextLoose();
    // Its bitmap centred on the stage: on the board, so nothing is settled, and
    // clear of every neighbour's origin, so nothing snaps.
    const [p] = mover.pieces;
    const stage = stageSize();
    const to = {
      x: stage.w / 2 - (p.x - p.offsetX) - p.width / 2,
      y: stage.h / 2 - (p.y - p.offsetY) - p.height / 2,
    };

    await drop(mover.el, to);

    expect(groups()).toHaveLength(COLS * ROWS);
    const dropped = groups().find((g) => g.el === mover.el)!;
    expect({ x: dropped.x, y: dropped.y }).toEqual(to);
    expect(saved).toHaveLength(1); // every drop is saved, joined or not
    expectSaveOfBoard(saved[0]);
  });

  it("pulls a group dropped off the board back on, on every side, dropped node included", async () => {
    await mount();
    const stage = stageSize();

    for (const to of [
      { x: -5000, y: -5000 },
      { x: 5000, y: 5000 },
    ]) {
      const mover = nextLoose();
      const node = await drop(mover.el, to);

      const dropped = groups().find((g) => g.el === mover.el)!;
      const box = extent(dropped);
      expect(box.left).toBeGreaterThanOrEqual(-1e-6);
      expect(box.top).toBeGreaterThanOrEqual(-1e-6);
      expect(box.right).toBeLessThanOrEqual(stage.w + 1e-6);
      expect(box.bottom).toBeLessThanOrEqual(stage.h + 1e-6);
      // react-konva would skip writing a settled position equal to the last
      // rendered one, so the board has to move the dropped node itself.
      expect({ x: node.x(), y: node.y() }).toEqual({ x: dropped.x, y: dropped.y });
    }
    expect(groups()).toHaveLength(COLS * ROWS);
  });

  it("draws the group being dragged on top, and only until it is dropped", async () => {
    await mount();
    const first = groups()[0];
    const props = groupProps.get(first.el)!;

    await act(async () => props.onDragStart());
    expect(groups()[COLS * ROWS - 1].el).toBe(first.el);

    // Dropped where it joins nothing, it goes back to its place in the order.
    await act(async () => props.onDragEnd({ currentTarget: fakeNode({ x: first.x, y: first.y }) }));
    expect(groups()).toHaveLength(COLS * ROWS);
    expect(groups()[0].el).toBe(first.el);
  });

  it("reports the solve once, on the drop that completes it, once it is saved", async () => {
    let savesWhenSolved = -1;
    onSolved.mockImplementation(() => {
      savesWhenSolved = saved.length;
    });
    await mount();
    await solve();

    expect(groups()).toHaveLength(1);
    expect(onProgress).toHaveBeenLastCalledWith(1, COLS * ROWS);
    expect(onSolved).toHaveBeenCalledTimes(1);
    // Saved first, so nothing the celebration does can cost the solve.
    expect(savesWhenSolved).toBe(saved.length);
    expect(readSave(saved[saved.length - 1])).toHaveLength(1);

    // Moving the finished picture is a drop too, but not a solve.
    const only = groups()[0];
    await drop(only.el, { x: only.x + 30, y: only.y + 20 });
    expect(onSolved).toHaveBeenCalledTimes(1);
  });

  it("does not report a solve for a finished puzzle it merely restores", async () => {
    stored = serialiseSolveState({
      groups: [
        {
          id: 1,
          x: 100,
          y: 100,
          members: Array.from({ length: COLS * ROWS }, (_, i) =>
            pieceId(Math.floor(i / COLS), i % COLS),
          ),
        },
      ],
      cols: COLS,
      rows: ROWS,
      stageW: 1400,
      stageH: 590,
      updatedAt: 1,
    });
    await mount();

    expect(groups()).toHaveLength(1);
    expect(onProgress).toHaveBeenLastCalledWith(1, COLS * ROWS);
    expect(onSolved).not.toHaveBeenCalled();
  });

  it("scatters afresh when the solver starts over", async () => {
    await mount();
    await joinNext();
    expect(groups()).toHaveLength(COLS * ROWS - 1);

    stored = null; // what the solver's startOver does before bumping the nonce
    await mount(1);

    expect(groups()).toHaveLength(COLS * ROWS);
    expect(onProgress).toHaveBeenLastCalledWith(COLS * ROWS, COLS * ROWS);
  });

  it("re-measures the height it may take whenever it lays out a new grid", async () => {
    // The board sits last in <main>; what it may take is the window below it.
    // A taller window by the time the solver picks another piece count must
    // give the new layout a taller stage, not the height from first mount.
    const main = document.createElement("main");
    document.body.appendChild(main);
    main.appendChild(container);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(700);
    await mount();
    const first = stageSize().h;

    vi.spyOn(window, "innerHeight", "get").mockReturnValue(1000);
    await mount(0, { cols: 8, rows: 6 });
    const second = stageSize().h;

    expect(first).toBe(700);
    expect(second).toBe(1000);
    main.remove();
  });

  it("keeps its stage while it is hidden and shown again", async () => {
    // Hiding the board (an <Activity>, a Suspense fallback) detaches its
    // wrapper's ref. Tearing the stage down for that would bring it back
    // unzoomed, while the zoom readout and the overview kept the old view.
    const shown = (mode: "visible" | "hidden") => <Activity mode={mode}>{board()}</Activity>;
    await act(async () => root.render(shown("visible")));
    await act(async () => {});
    const stage = container.querySelector("[data-stage]");
    expect(stage).not.toBeNull();

    await act(async () => root.render(shown("hidden")));
    await act(async () => root.render(shown("visible")));
    await act(async () => {});

    expect(container.querySelector("[data-stage]")).toBe(stage);
  });

  it("lets the board pan again after a pinch the system cancels", async () => {
    await mount();
    const stage = container.querySelector("[data-stage]")!;
    const touch = (type: string, points: Array<[number, number]>) => {
      const e = new Event(type, { cancelable: true });
      Object.defineProperty(e, "touches", {
        value: points.map(([clientX, clientY]) => ({ clientX, clientY })),
      });
      stage.dispatchEvent(e);
    };

    touch("touchmove", [
      [0, 0],
      [100, 0],
    ]);
    expect(stageDraggable).toEqual([false]); // no panning while pinching

    // A system gesture takes over, and the browser cancels the touches rather
    // than ending them.
    touch("touchcancel", []);
    expect(stageDraggable).toEqual([false, true]);
  });

  it("gathers the loose pieces on request, leaving assemblies alone, and saves", async () => {
    await mount();
    await joinNext();
    const assembly = groups().find((g) => g.pieces.length === 2)!;
    const before = groups().map((g) => ({ x: g.x, y: g.y }));
    saved = [];

    await act(async () => actions.current!.gatherLoose());

    const after = groups();
    expect(after.find((g) => g.pieces.length === 2)).toMatchObject({ x: assembly.x, y: assembly.y });
    expect(after.map((g) => ({ x: g.x, y: g.y }))).not.toEqual(before);
    expect(saved).toHaveLength(1);
    // What was saved is the gathered board, so a reload does not undo it.
    expectSaveOfBoard(saved[0]);
  });
});
