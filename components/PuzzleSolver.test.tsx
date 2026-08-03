import { useEffect } from "react";
import { act } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "@/messages/en.json";
import { computeGrid } from "@/lib/puzzle/grid";
import PuzzleSolver from "./PuzzleSolver";

// The real board needs a canvas jsdom does not provide. The stub keeps the one
// thing the solver reads from it — the progress report, which carries the grid
// it belongs to — and `board` decides which grids it reports for, so a board
// that has not rebuilt yet can be simulated.
const board = vi.hoisted<{
  reportsFor: (total: number) => boolean;
  groupsFor: (total: number) => number;
  /** What the solver last asked the board to show; see the overview toggle. */
  showMinimap: boolean | null;
}>(() => ({
  reportsFor: () => true,
  groupsFor: (total) => total,
  showMinimap: null,
}));

vi.mock("./PuzzleBoard", () => {
  function BoardStub({
    cols,
    rows,
    showMinimap,
    onProgress,
  }: {
    cols: number;
    rows: number;
    showMinimap: boolean;
    onProgress: (groups: number, total: number) => void;
  }) {
    const total = cols * rows;
    // In an effect, not the render body: a render side effect would double-fire
    // the moment this suite ever runs under StrictMode.
    useEffect(() => {
      board.showMinimap = showMinimap;
    }, [showMinimap]);
    useEffect(() => {
      if (board.reportsFor(total)) onProgress(board.groupsFor(total), total);
    }, [total, onProgress]);
    return null;
  }
  return { default: BoardStub };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const puzzle = {
  id: "p1",
  imageKey: "key.webp",
  imageWidth: 1200,
  imageHeight: 800,
  pieceCount: 108, // what the creator picked; the fallback when nothing is stored
  seed: 1,
};

const storageKey = `pc:${puzzle.id}`;

// The progress line shows `cols * rows - 1` connections, not the piece count:
// computeGrid only approximates a preset. It hits both of these exactly for
// this aspect ratio (12 × 9 and 4 × 3) — pinned by the first test below, so a
// retuned computeGrid fails loudly instead of leaving these numbers stale.
const CONNECTIONS_108 = 107;
const CONNECTIONS_12 = 11;

function tree() {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      <PuzzleSolver puzzle={puzzle} title="Test" />
    </NextIntlClientProvider>
  );
}

/**
 * Render as the server does. Hides `window` *and* the globals jsdom leaves
 * reachable without it, so a component that reads storage as bare
 * `localStorage` fails here too instead of silently defeating the guard.
 */
function serverHtml() {
  const hidden = ["window", "localStorage", "sessionStorage", "document", "navigator"] as const;
  const saved = hidden.map((key) => [key, Reflect.get(globalThis, key)] as const);
  for (const key of hidden) Reflect.deleteProperty(globalThis, key);
  try {
    return renderToString(tree());
  } finally {
    for (const [key, value] of saved) Reflect.set(globalThis, key, value);
  }
}

describe("PuzzleSolver", () => {
  let container: HTMLDivElement;
  let root: Root | undefined;

  function hydrate() {
    return act(async () => {
      root = hydrateRoot(container, tree());
    });
  }

  /**
   * The two numbers in the progress line. Read as numbers rather than matching
   * the sentence, so rewording `solve.progress` does not break these tests —
   * but the connected count is still asserted, which is where the bugs were.
   */
  function progress() {
    const text = container.querySelector(".progress")?.textContent ?? "";
    const [connected, total] = (text.match(/-?\d+/g) ?? []).map(Number);
    return { connected, total };
  }

  function select() {
    return container.querySelector<HTMLSelectElement>("#piece-count");
  }

  /** Pick a value in the piece-count select the way a user would. */
  function choose(value: string) {
    const el = select()!;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    setter.call(el, value);
    return act(async () => {
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  /** A toolbar toggle, found the way a user reads it — by its label. */
  function toggle(label: string) {
    return [...container.querySelectorAll("button")].find((b) => b.textContent === label);
  }

  beforeEach(() => {
    board.reportsFor = () => true;
    board.groupsFor = (total) => total;
    board.showMinimap = null;
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(async () => {
    // Unmount, or the effects of one test keep running during the next.
    if (root) await act(async () => root!.unmount());
    root = undefined;
    container.remove();
    vi.restoreAllMocks();
  });

  it("uses the grids the expected connection counts assume", () => {
    const aspect = puzzle.imageWidth / puzzle.imageHeight;
    expect(computeGrid(108, aspect)).toMatchObject({ cols: 12, rows: 9 });
    expect(computeGrid(12, aspect)).toMatchObject({ cols: 4, rows: 3 });
  });

  it("hydrates without a mismatch when a piece count was remembered", async () => {
    window.localStorage.setItem(storageKey, "12");
    container.innerHTML = serverHtml();

    // `onRecoverableError` replaces React's default handler, which is the one
    // that logs to the console — a mismatch arrives on exactly one of the two.
    // The console spy is a separate net for other React warnings.
    const onRecoverableError = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => {
      root = hydrateRoot(container, tree(), { onRecoverableError });
    });

    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("hydrates without a mismatch when nothing is stored", async () => {
    container.innerHTML = serverHtml();

    const onRecoverableError = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => {
      root = hydrateRoot(container, tree(), { onRecoverableError });
    });

    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(progress()).toEqual({ connected: 0, total: CONNECTIONS_108 });
    expect(select()?.value).toBe("108");
  });

  it("applies the remembered piece count after mount", async () => {
    window.localStorage.setItem(storageKey, "12");
    container.innerHTML = serverHtml();

    expect(progress()).toEqual({ connected: 0, total: CONNECTIONS_108 });

    await hydrate();

    expect(progress()).toEqual({ connected: 0, total: CONNECTIONS_12 });
    expect(select()?.value).toBe("12");
  });

  it("counts nothing as connected until the board has rebuilt for the new grid", async () => {
    // The board keeps reporting the grid it was built for: its chunk and the
    // image still have to load before it rebuilds for the remembered count.
    board.reportsFor = (total) => total === 108;
    window.localStorage.setItem(storageKey, "12");
    container.innerHTML = serverHtml();

    await hydrate();

    expect(progress()).toEqual({ connected: 0, total: CONNECTIONS_12 });
  });

  it("ignores a stored value that is not a preset", async () => {
    window.localStorage.setItem(storageKey, "7");
    container.innerHTML = serverHtml();

    await hydrate();

    expect(select()?.value).toBe("108");
  });

  it("ignores a piece count stored for a different puzzle", async () => {
    window.localStorage.setItem("pc:another-puzzle", "12");
    container.innerHTML = serverHtml();

    await hydrate();

    expect(select()?.value).toBe("108");
  });

  it("remembers a piece count the solver picks", async () => {
    container.innerHTML = serverHtml();
    await hydrate();

    await choose("48");

    expect(window.localStorage.getItem(storageKey)).toBe("48");
    expect(select()?.value).toBe("48");
  });

  it("does not store anything when the count does not change", async () => {
    container.innerHTML = serverHtml();
    await hydrate();

    await choose("108");

    expect(window.localStorage.getItem(storageKey)).toBeNull();
  });

  it("does not ask before discarding progress on an untouched board", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    container.innerHTML = serverHtml();
    await hydrate();

    await choose("48");

    expect(confirm).not.toHaveBeenCalled();
  });

  it("shows the board overview until the solver switches it off", async () => {
    container.innerHTML = serverHtml();
    await hydrate();

    expect(board.showMinimap).toBe(true);

    await act(async () => toggle(messages.solve.hideMap)!.click());
    expect(board.showMinimap).toBe(false);
    expect(toggle(messages.solve.showMap)?.getAttribute("aria-pressed")).toBe("false");

    await act(async () => toggle(messages.solve.showMap)!.click());
    expect(board.showMinimap).toBe(true);
  });

  it("keeps the count when the solver declines to discard progress", async () => {
    board.groupsFor = (total) => total - 3; // three connections made
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    container.innerHTML = serverHtml();
    await hydrate();

    expect(progress()).toEqual({ connected: 3, total: CONNECTIONS_108 });

    await choose("48");

    expect(confirm).toHaveBeenCalledOnce();
    expect(select()?.value).toBe("108");
    expect(window.localStorage.getItem(storageKey)).toBeNull();
  });
});
