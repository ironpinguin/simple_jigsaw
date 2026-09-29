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
import {
  deserialiseSolveState,
  readSolveTiming,
  serialiseSolveState,
} from "@/lib/puzzle/solveState";
import type { PieceStyle } from "@/lib/puzzle/style";
import { BOARD_BACKGROUND_COLORS, type BoardBackground } from "@/lib/puzzle/background";
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

/** The stage transform, as the board would have left it on a real Konva stage. */
const stageView = { x: 0, y: 0, scale: 1 };

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
    // effect listens on its container and pauses panning while pinching, and a
    // resize carries the view over to the new stage size.
    useImperativeHandle(ref, () => ({
      container: () => el.current,
      draggable: (on: boolean) => {
        stageDraggable.push(on);
      },
      x: () => stageView.x,
      y: () => stageView.y,
      scaleX: () => stageView.scale,
      position: (p: { x: number; y: number }) => {
        stageView.x = p.x;
        stageView.y = p.y;
      },
      batchDraw: () => {},
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
  pieceStyle: "classic" as const,
  boardBackground: "dark" as const,
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
  let timing: { elapsedMs: number; moves: number };
  let onSeeded: ReturnType<
    typeof vi.fn<(t: { elapsedMs: number; moves: number } | null, solved: boolean) => void>
  >;
  let onPieceGrab: ReturnType<typeof vi.fn<() => void>>;
  let onPieceDrop: ReturnType<typeof vi.fn<() => void>>;
  const actions = createRef<BoardActions | null>();

  function board(
    resetNonce = 0,
    grid = { cols: COLS, rows: ROWS },
    pieceStyle: PieceStyle = "classic",
    background: BoardBackground = "dark",
  ) {
    return (
      <NextIntlClientProvider locale="en" messages={messages}>
        <PuzzleBoard
          puzzle={puzzle}
          cols={grid.cols}
          rows={grid.rows}
          pieceStyle={pieceStyle}
          background={background}
          showMinimap={false}
          onProgress={onProgress}
          onSolved={onSolved}
          loadSolveState={loadSolveState}
          saveSolveState={saveSolveState}
          resetNonce={resetNonce}
          readTiming={readTiming}
          onSeeded={onSeeded}
          onPieceGrab={onPieceGrab}
          onPieceDrop={onPieceDrop}
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
  const readTiming = () => timing;

  async function mount(
    resetNonce = 0,
    grid = { cols: COLS, rows: ROWS },
    pieceStyle: PieceStyle = "classic",
    background: BoardBackground = "dark",
  ) {
    await act(async () => {
      root.render(board(resetNonce, grid, pieceStyle, background));
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
    const node = fakeNode(to);
    await act(async () => groupProps.get(el)!.onDragStart());
    // Re-read: starting the drag re-renders the board, and Konva calls the
    // handler of the latest render, not the one the drag started with.
    await act(async () => groupProps.get(el)!.onDragEnd({ currentTarget: node }));
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
    Object.assign(stageView, { x: 0, y: 0, scale: 1 });
    onProgress = vi.fn();
    onSolved = vi.fn();
    timing = { elapsedMs: 0, moves: 0 };
    onSeeded = vi.fn();
    onPieceGrab = vi.fn();
    onPieceDrop = vi.fn();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("the board background (#147)", () => {
    const wrap = () => container.querySelector<HTMLElement>(".board-wrap")!;
    /** jsdom normalises the hex into rgb(); compare in that form. */
    function rgb(hex: string) {
      const probe = document.createElement("div");
      probe.style.background = hex;
      return probe.style.background;
    }

    it("paints the table in the chosen preset's colour", async () => {
      await mount(0, undefined, "classic", "cream");
      expect(wrap().style.background).toBe(rgb(BOARD_BACKGROUND_COLORS.cream));
    });

    it("repaints when the solver switches, leaving every piece where it lay", async () => {
      await mount(0, undefined, "classic", "dark");
      const where = () => groups().map(({ x, y }) => ({ x, y }));
      const before = where();
      await act(async () => root.render(board(0, undefined, "classic", "felt")));

      expect(wrap().style.background).toBe(rgb(BOARD_BACKGROUND_COLORS.felt));
      expect(where()).toEqual(before);
    });
  });

  describe("the solve timer's plumbing", () => {
    it("says when a piece is picked up and put down, counting before the save", async () => {
      await mount();
      onPieceDrop.mockImplementation(() => {
        // What the solver does: the move is on the clock by the time it is saved.
        timing = { elapsedMs: 4_000, moves: timing.moves + 1 };
        expect(saved).toHaveLength(0);
      });

      await joinNext();

      expect(onPieceGrab).toHaveBeenCalledTimes(1);
      expect(onPieceDrop).toHaveBeenCalledTimes(1);
      expect(readSolveTiming(saved.at(-1)!)).toEqual({ elapsedMs: 4_000, moves: 1 });
    });

    /** Mount again, resuming from the last save — `edit` may change it first. */
    async function remount(edit: (state: Record<string, unknown>) => void = () => {}) {
      const state = JSON.parse(saved.at(-1)!);
      edit(state);
      stored = JSON.stringify(state);
      await act(async () => root.unmount());
      root = createRoot(container);
      await mount();
    }

    it("hands the stored timing back when it restores, and zero when it scatters", async () => {
      await mount();
      expect(onSeeded).toHaveBeenLastCalledWith({ elapsedMs: 0, moves: 0 }, false);

      timing = { elapsedMs: 83_000, moves: 12 };
      await joinNext();
      await remount();

      expect(onSeeded).toHaveBeenLastCalledWith({ elapsedMs: 83_000, moves: 12 }, false);
    });

    it("hands back no timing for a state stored before the timer", async () => {
      await mount();
      await joinNext();
      await remount((state) => {
        delete state.elapsedMs;
        delete state.moves;
      });

      expect(onSeeded).toHaveBeenLastCalledWith(null, false);
    });

    it("says when the state it restored is already solved", async () => {
      await mount();
      await solve();
      await remount();

      expect(onSeeded).toHaveBeenLastCalledWith(expect.anything(), true);
    });

    it("saves on request, with the current timing", async () => {
      await mount();
      timing = { elapsedMs: 9_000, moves: 3 };
      await act(async () => actions.current!.save());
      expect(saved).toHaveLength(1);
      expect(readSolveTiming(saved[0])).toEqual({ elapsedMs: 9_000, moves: 3 });
      expect(deserialiseSolveState(saved[0], { cols: COLS, rows: ROWS, stageW: 1, stageH: 1 }))
        .not.toBeNull();
    });
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

    await act(async () => groupProps.get(first.el)!.onDragStart());
    expect(groups()[COLS * ROWS - 1].el).toBe(first.el);

    // Dropped where it joins nothing, it goes back to its place in the order.
    await act(async () =>
      groupProps.get(first.el)!.onDragEnd({ currentTarget: fakeNode({ x: first.x, y: first.y }) }),
    );
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

  it("carries the solve over to another piece style, without going back to storage", async () => {
    await mount();
    await joinNext();
    const sizes = () => groups().map((g) => g.pieces.length).sort();
    const bitmapArea = () =>
      groups().reduce((sum, g) => sum + g.pieces.reduce((a, p) => a + p.width * p.height, 0), 0);
    const joined = sizes();
    const classicArea = bitmapArea();
    const seeds = onSeeded.mock.calls.length;
    const saves = saved.length;
    // As where storage is blocked: reloading from it would scatter afresh.
    stored = null;

    await mount(0, { cols: COLS, rows: ROWS }, "wooden");

    expect(sizes()).toEqual(joined);
    // Cut anew: the wooden knobs reach further, so every bitmap grows.
    expect(bitmapArea()).toBeGreaterThan(classicArea);
    expect(onProgress).toHaveBeenLastCalledWith(COLS * ROWS - 1, COLS * ROWS);
    // The clock runs on, and there is nothing new to write.
    expect(onSeeded).toHaveBeenCalledTimes(seeds);
    expect(saved).toHaveLength(saves);
  });

  describe("following the window (#145)", () => {
    let main: HTMLElement;
    let width: ReturnType<typeof vi.spyOn>;
    let height: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      // The board sits last in <main>; what it may take is the window below it.
      main = document.createElement("main");
      document.body.appendChild(main);
      main.appendChild(container);
      width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1400);
      height = vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });

    afterEach(() => {
      vi.useRealTimers();
      main.remove();
    });

    /** Resize the window to `w` x `h`, and let the resize settle. */
    async function resizeTo(w: number, h: number) {
      width.mockReturnValue(w);
      height.mockReturnValue(h);
      await act(async () => {
        window.dispatchEvent(new Event("resize"));
      });
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
    }

    const sizes = () => groups().map((g) => g.pieces.length).sort();
    const pieceWidth = () => groups()[0].pieces[0].width;

    function expectAllOnBoard() {
      const { w, h } = stageSize();
      for (const g of groups()) {
        const e = extent(g);
        expect(e.left).toBeGreaterThanOrEqual(-1e-6);
        expect(e.top).toBeGreaterThanOrEqual(-1e-6);
        expect(e.right).toBeLessThanOrEqual(w + 1e-6);
        expect(e.bottom).toBeLessThanOrEqual(h + 1e-6);
      }
    }

    it("grows the stage and the pieces with a larger window, carrying the solve over", async () => {
      await mount();
      await joinNext();
      expect(stageSize()).toEqual({ w: 1400, h: 800 });
      const joined = sizes();
      const before = pieceWidth();
      const seeds = onSeeded.mock.calls.length;
      const saves = saved.length;
      stored = null; // as where storage is blocked: the carry-over must not need it

      await resizeTo(2400, 1300);

      expect(stageSize()).toEqual({ w: 2400, h: 1300 });
      expect(pieceWidth()).toBeGreaterThan(before);
      expect(sizes()).toEqual(joined);
      expect(onProgress).toHaveBeenLastCalledWith(COLS * ROWS - 1, COLS * ROWS);
      // The clock runs on, and there is nothing new to write.
      expect(onSeeded).toHaveBeenCalledTimes(seeds);
      expect(saved).toHaveLength(saves);
      expectAllOnBoard();
    });

    it("waits for the resize to settle before it lays out again", async () => {
      await mount();
      width.mockReturnValue(2000);
      await act(async () => {
        window.dispatchEvent(new Event("resize"));
        vi.advanceTimersByTime(150);
        window.dispatchEvent(new Event("resize"));
        vi.advanceTimersByTime(150);
      });
      expect(stageSize().w).toBe(1400);

      await act(async () => {
        vi.advanceTimersByTime(50);
      });
      expect(stageSize().w).toBe(2000);
    });

    it("follows a change of the window's height alone", async () => {
      await mount();
      await resizeTo(1400, 1100);
      expect(stageSize()).toEqual({ w: 1400, h: 1100 });
    });

    it("lays nothing out again for a resize the stage does not follow", async () => {
      // A phone's address bar sliding away: the window gets taller, but the
      // board was below its minimum height before and still is.
      height.mockReturnValue(300);
      await mount();
      expect(stageSize().h).toBe(520);
      const reports = onProgress.mock.calls.length;

      await resizeTo(1400, 450);

      expect(stageSize().h).toBe(520);
      // A carry-over would have reported the progress again.
      expect(onProgress).toHaveBeenCalledTimes(reports);
    });

    it("keeps the bitmaps when a resize leaves the pieces as big as they were", async () => {
      // 4:3 on 1400 x 800 is bounded by the width; a taller window leaves it be.
      await mount();
      const getContext = vi.mocked(HTMLCanvasElement.prototype.getContext);
      const rasterised = getContext.mock.calls.length;
      const before = pieceWidth();

      await resizeTo(1400, 1100);

      expect(stageSize()).toEqual({ w: 1400, h: 1100 });
      expect(pieceWidth()).toBe(before);
      expect(getContext).toHaveBeenCalledTimes(rasterised);
      expectAllOnBoard();
    });

    it("shrinks with a smaller window, of another shape, and keeps every group on the board", async () => {
      await mount();
      // Park a group in the far corner, where a smaller stage cuts it off.
      const { w, h } = stageSize();
      await drop(nextLoose().el, { x: w, y: h });
      await joinNext();
      const joined = sizes();

      await resizeTo(700, 1000);

      expect(stageSize()).toEqual({ w: 700, h: 1000 });
      expect(sizes()).toEqual(joined);
      expectAllOnBoard();
    });

    it("keeps the same part of the board in view, at the same zoom", async () => {
      await mount();
      Object.assign(stageView, { x: -300, y: -200, scale: 2 });

      await resizeTo(2800, 1200);

      expect(stageView).toEqual({ x: -600, y: -300, scale: 2 });
    });

    it("does not rebuild while a piece is being dragged, only after the drop", async () => {
      await mount();
      const a = anchor();
      const el = nextLoose().el;
      await act(async () => groupProps.get(el)!.onDragStart());

      await resizeTo(2400, 1300);
      expect(stageSize()).toEqual({ w: 1400, h: 800 });

      const node = fakeNode({ x: a.x, y: a.y });
      await act(async () => groupProps.get(el)!.onDragEnd({ currentTarget: node }));

      // The drop joined against the layout it started in, and the new room
      // was taken right after, with the join carried over.
      expect(stageSize()).toEqual({ w: 2400, h: 1300 });
      expect(groups()).toHaveLength(COLS * ROWS - 1);
      expectAllOnBoard();
    });
  });

  it("keeps its stage and its pieces while it is hidden and shown again", async () => {
    // Hiding the board (an <Activity>, a Suspense fallback) detaches its
    // wrapper's ref. Tearing the stage down for that would bring it back
    // unzoomed, while the zoom readout and the overview kept the old view.
    const shown = (mode: "visible" | "hidden") => <Activity mode={mode}>{board()}</Activity>;
    await act(async () => root.render(shown("visible")));
    await act(async () => {});
    const stage = container.querySelector("[data-stage]");
    expect(stage).not.toBeNull();
    // Showing it again also re-runs its effects. Reseeding for that would go
    // back to storage — which here, as where storage is blocked, has nothing —
    // and lose the join; reloading the image would re-rasterise every piece.
    await joinNext();
    const rasterised = vi.mocked(HTMLCanvasElement.prototype.getContext).mock.calls.length;

    await act(async () => root.render(shown("hidden")));
    await act(async () => root.render(shown("visible")));
    await act(async () => {});

    expect(container.querySelector("[data-stage]")).toBe(stage);
    expect(groups()).toHaveLength(COLS * ROWS - 1);
    expect(vi.mocked(HTMLCanvasElement.prototype.getContext).mock.calls).toHaveLength(rasterised);
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
