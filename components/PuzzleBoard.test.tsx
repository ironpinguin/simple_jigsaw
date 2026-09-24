import { act, createRef, useImperativeHandle, type ReactNode, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "@/messages/en.json";
import { serialiseSolveState } from "@/lib/puzzle/solveState";
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

vi.mock("react-konva", () => {
  function Stage({ children, ref }: { children?: ReactNode; ref?: Ref<unknown> }) {
    const container = document.createElement("div");
    useImperativeHandle(ref, () => ({
      x: () => 0,
      y: () => 0,
      scaleX: () => 1,
      container: () => container,
      draggable: () => {},
    }));
    return <div data-stage="">{children}</div>;
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
  function Image({ x, y }: { x: number; y: number }) {
    return <span data-piece="" data-x={x} data-y={y} />;
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
      width = 1200;
      height = 900;
      set src(_: string) {
        queueMicrotask(() => this.onload?.());
      }
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1400);
}

describe("PuzzleBoard", () => {
  let container: HTMLDivElement;
  let root: Root;
  let stored: string | null;
  let saved: string[];
  let onProgress: ReturnType<typeof vi.fn<(groups: number, total: number) => void>>;
  let onSolved: ReturnType<typeof vi.fn<() => void>>;
  const actions = createRef<BoardActions | null>();

  function board(resetNonce = 0) {
    return (
      <NextIntlClientProvider locale="en" messages={messages}>
        <PuzzleBoard
          puzzle={puzzle}
          cols={COLS}
          rows={ROWS}
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

  async function mount(resetNonce = 0) {
    await act(async () => {
      root.render(board(resetNonce));
    });
    // The image "loads" in a microtask; let the layout build and seed.
    await act(async () => {});
  }

  /** The groups as rendered, each with its solved piece offsets. */
  function groups() {
    return [...container.querySelectorAll("[data-group]")].map((el) => ({
      el,
      x: Number(el.getAttribute("data-x")),
      y: Number(el.getAttribute("data-y")),
      pieces: [...el.querySelectorAll("[data-piece]")].map((p) => ({
        x: Number(p.getAttribute("data-x")),
        y: Number(p.getAttribute("data-y")),
      })),
    }));
  }

  /** The group holding the top-left piece: every other group snaps onto its origin. */
  function anchor() {
    return groups().find((g) => g.pieces.some((p) => p.x === 0 && p.y === 0))!;
  }

  /** Drop `el`'s group at `to`, the way Konva reports the end of a drag. */
  async function drop(el: Element, to: { x: number; y: number }) {
    const props = groupProps.get(el)!;
    let pos = { ...to };
    const node: FakeNode = {
      x: () => pos.x,
      y: () => pos.y,
      position: (p) => {
        if (p) pos = p;
      },
    };
    await act(async () => props.onDragStart());
    await act(async () => props.onDragEnd({ currentTarget: node }));
  }

  /** Join every loose piece onto the anchor's assembly. */
  async function solve() {
    for (let guard = 0; guard < COLS * ROWS && groups().length > 1; guard++) {
      const a = anchor();
      const mover = groups().find((g) => g.el !== a.el)!;
      await drop(mover.el, { x: a.x, y: a.y });
    }
  }

  beforeEach(() => {
    stubBrowser();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    stored = null;
    saved = [];
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

  it("resumes a stored solve", async () => {
    // A state with the whole top row already joined.
    const members = (r: number) => Array.from({ length: COLS }, (_, c) => `${r}-${c}`);
    const pieces = [
      { id: 1, x: 10, y: 10, members: members(0) },
      ...[1, 2].flatMap((r) =>
        Array.from({ length: COLS }, (_, c) => ({
          id: 10 + r * COLS + c,
          x: 50 + c * 90,
          y: 300 + r * 90,
          members: [`${r}-${c}`],
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
    const a = anchor();
    const other = groups().find((g) => g.el !== a.el)!;

    await drop(other.el, { x: a.x, y: a.y });

    expect(groups()).toHaveLength(COLS * ROWS - 1);
    expect(onProgress).toHaveBeenLastCalledWith(COLS * ROWS - 1, COLS * ROWS);
    expect(saved).toHaveLength(1);
    const state = JSON.parse(saved[0]);
    expect(state.groups.some((g: { members: string[] }) => g.members.length === 2)).toBe(true);
  });

  it("leaves a piece dropped far from any neighbour on its own", async () => {
    await mount();
    const a = anchor();
    const other = groups().find((g) => g.el !== a.el)!;

    await drop(other.el, { x: a.x + 400, y: a.y + 200 });

    expect(groups()).toHaveLength(COLS * ROWS);
    expect(saved).toHaveLength(1); // every drop is saved, joined or not
  });

  it("draws the group being dragged on top", async () => {
    await mount();
    const first = groups()[0];
    await act(async () => groupProps.get(first.el)!.onDragStart());

    const last = groups()[groups().length - 1];
    expect({ x: last.x, y: last.y }).toEqual({ x: first.x, y: first.y });
  });

  it("reports the solve once, on the drop that completes it", async () => {
    await mount();
    await solve();

    expect(groups()).toHaveLength(1);
    expect(onProgress).toHaveBeenLastCalledWith(1, COLS * ROWS);
    expect(onSolved).toHaveBeenCalledTimes(1);

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
          members: Array.from({ length: COLS * ROWS }, (_, i) => `${Math.floor(i / COLS)}-${i % COLS}`),
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
    const a = anchor();
    await drop(groups().find((g) => g.el !== a.el)!.el, { x: a.x, y: a.y });
    expect(groups()).toHaveLength(COLS * ROWS - 1);

    stored = null; // what the solver's startOver does before bumping the nonce
    await mount(1);

    expect(groups()).toHaveLength(COLS * ROWS);
    expect(onProgress).toHaveBeenLastCalledWith(COLS * ROWS, COLS * ROWS);
  });

  it("gathers the loose pieces on request, leaving assemblies alone, and saves", async () => {
    await mount();
    const a = anchor();
    await drop(groups().find((g) => g.el !== a.el)!.el, { x: a.x, y: a.y });
    const assembly = groups().find((g) => g.pieces.length === 2)!;
    const before = groups().map((g) => ({ x: g.x, y: g.y }));
    saved = [];

    await act(async () => actions.current!.gatherLoose());

    const after = groups();
    expect(after.find((g) => g.pieces.length === 2)).toMatchObject({ x: assembly.x, y: assembly.y });
    expect(after.map((g) => ({ x: g.x, y: g.y }))).not.toEqual(before);
    expect(saved).toHaveLength(1);
  });
});
