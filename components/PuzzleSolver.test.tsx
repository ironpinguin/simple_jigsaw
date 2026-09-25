import { useEffect, useImperativeHandle, type Ref } from "react";
import { act } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "@/messages/en.json";
import { computeGrid } from "@/lib/puzzle/grid";
import { MAX_STORED_SOLVES, SOLVE_STATE_VERSION } from "@/lib/puzzle/solveState";
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
  /** The solve-state plumbing, captured so a test can drive it like the board. */
  loadSolveState: (() => string | null) | null;
  saveSolveState: ((raw: string) => void) | null;
  /** Bumped by the solver to tell the board to scatter afresh. */
  resetNonce: number | null;
  /** How often the solver asked the board to gather its loose pieces. */
  gathered: number;
  /** The completion callback, so a test can finish the puzzle like a drop. */
  onSolved: (() => void) | null;
}>(() => ({
  reportsFor: () => true,
  groupsFor: (total) => total,
  showMinimap: null,
  loadSolveState: null,
  saveSolveState: null,
  resetNonce: null,
  gathered: 0,
  onSolved: null,
}));

// Canvas and Web Audio are beyond jsdom; what matters here is when it is asked.
const celebration = vi.hoisted(() => ({ celebrate: vi.fn(), stopCelebration: vi.fn() }));
vi.mock("./celebrate", () => celebration);

vi.mock("./PuzzleBoard", () => {
  function BoardStub({
    cols,
    rows,
    showMinimap,
    onProgress,
    onSolved,
    loadSolveState,
    saveSolveState,
    resetNonce,
    actionsRef,
  }: {
    cols: number;
    rows: number;
    showMinimap: boolean;
    onProgress: (groups: number, total: number) => void;
    onSolved: () => void;
    loadSolveState: () => string | null;
    saveSolveState: (raw: string) => void;
    resetNonce: number;
    actionsRef?: Ref<{ gatherLoose: () => void } | null>;
  }) {
    const total = cols * rows;
    useImperativeHandle(actionsRef, () => ({ gatherLoose: () => board.gathered++ }), []);
    // In an effect, not the render body: a render side effect would double-fire
    // the moment this suite ever runs under StrictMode.
    useEffect(() => {
      board.showMinimap = showMinimap;
    }, [showMinimap]);
    useEffect(() => {
      board.onSolved = onSolved;
    }, [onSolved]);
    useEffect(() => {
      board.loadSolveState = loadSolveState;
      board.saveSolveState = saveSolveState;
      board.resetNonce = resetNonce;
    }, [loadSolveState, saveSolveState, resetNonce]);
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
const solveKey = `solve:${puzzle.id}`;

/** A stored solve state, as far as the solver cares: opaque JSON with a stamp. */
function solveJson(updatedAt: number) {
  return JSON.stringify({ version: SOLVE_STATE_VERSION, updatedAt, groups: [] });
}

// The progress line shows `cols * rows - 1` connections, not the piece count:
// computeGrid only approximates a preset. It hits both of these exactly for
// this aspect ratio (12 × 9 and 4 × 3) — pinned by the first test below, so a
// retuned computeGrid fails loudly instead of leaving these numbers stale.
const CONNECTIONS_108 = 107;
const CONNECTIONS_12 = 11;

function tree(isPublic = true) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      <PuzzleSolver puzzle={puzzle} title="Test" isPublic={isPublic} />
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

  /**
   * A button's accessible name, as far as this toolbar needs it: its
   * `aria-label`, or else its text without the decorative icon.
   */
  function nameOf(el: Element) {
    const label = el.getAttribute("aria-label");
    if (label !== null) return label;
    const copy = el.cloneNode(true) as Element;
    copy.querySelectorAll("[aria-hidden='true']").forEach((n) => n.remove());
    return copy.textContent?.trim() ?? "";
  }

  /**
   * A toolbar button, found the way a user reads it — by its name. The first
   * match: on a narrow screen the toggles are repeated in the menu.
   */
  function button(name: string) {
    return [...container.querySelectorAll("button")].find((b) => nameOf(b) === name);
  }

  function menuTrigger() {
    return button(messages.solve.more)!;
  }

  /** Open the overflow menu the way a user would, unless it already is. */
  function openMenu() {
    return act(async () => {
      if (menuTrigger().getAttribute("aria-expanded") !== "true") menuTrigger().click();
    });
  }

  /** Start over from the overflow menu, the way a user reaches it. */
  async function reset() {
    await openMenu();
    return act(async () => button(messages.solve.reset)!.click());
  }

  beforeEach(() => {
    board.reportsFor = () => true;
    board.groupsFor = (total) => total;
    board.showMinimap = null;
    board.gathered = 0;
    board.onSolved = null;
    celebration.celebrate.mockClear();
    celebration.stopCelebration.mockClear();
    board.loadSolveState = null;
    board.saveSolveState = null;
    board.resetNonce = null;
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

  it("offers the report entry on a public puzzle but not on a private one", async () => {
    // /api/report answers 404 for a private puzzle, so an owner or admin
    // looking at their own private puzzle would be told it does not exist.
    await act(async () => {
      root = createRoot(container);
      root.render(tree(false));
    });
    await openMenu();
    expect(button(messages.report.reportLink)).toBeUndefined();

    await act(async () => root!.render(tree(true)));
    expect(button(messages.report.reportLink)).toBeDefined();
  });

  describe("the toolbar", () => {
    it("gives every icon button a name and a tooltip", async () => {
      container.innerHTML = serverHtml();
      await hydrate();

      const bar = container.querySelector(".solve-toolbar")!;
      for (const b of bar.querySelectorAll(".icon-button")) {
        expect(b.getAttribute("aria-label")).toBeTruthy();
        expect(b.getAttribute("title")).toBeTruthy();
      }
    });

    it("keeps the instructions behind the help button", async () => {
      container.innerHTML = serverHtml();
      await hydrate();

      const help = button(messages.solve.help)!;
      const panel = document.getElementById(help.getAttribute("aria-controls")!)!;
      expect(panel.textContent).toBe(messages.solve.instructions);
      expect(panel.hidden).toBe(true);

      await act(async () => help.click());
      expect(help.getAttribute("aria-expanded")).toBe("true");
      expect(panel.hidden).toBe(false);
    });

    it("closes the menu on Escape and returns focus to its trigger", async () => {
      container.innerHTML = serverHtml();
      await hydrate();

      await openMenu();
      const share = button(messages.solve.share)!;
      share.focus();
      await act(async () => {
        share.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });

      expect(menuTrigger().getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(menuTrigger());
    });

    it("closes the menu on Escape even when focus is not inside it", async () => {
      container.innerHTML = serverHtml();
      await hydrate();

      await openMenu();
      (document.activeElement as HTMLElement | null)?.blur();
      await act(async () => {
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });

      expect(menuTrigger().getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(menuTrigger());
    });

    it("closes the menu on a press outside it", async () => {
      container.innerHTML = serverHtml();
      await hydrate();

      await openMenu();
      await act(async () => {
        document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      });

      expect(menuTrigger().getAttribute("aria-expanded")).toBe("false");
    });

    it("opens the report dialog from the menu and hands focus back to the menu", async () => {
      container.innerHTML = serverHtml();
      await hydrate();

      await openMenu();
      await act(async () => button(messages.report.reportLink)!.click());
      const dialog = container.querySelector<HTMLElement>("[role='dialog']")!;
      expect(dialog).not.toBeNull();
      expect(menuTrigger().getAttribute("aria-expanded")).toBe("false");

      await act(async () => {
        dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
      expect(container.querySelector("[role='dialog']")).toBeNull();
      expect(document.activeElement).toBe(menuTrigger());
    });
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

    expect(button(messages.solve.overview)?.getAttribute("aria-pressed")).toBe("true");
    await act(async () => button(messages.solve.overview)!.click());
    expect(board.showMinimap).toBe(false);
    expect(button(messages.solve.overview)?.getAttribute("aria-pressed")).toBe("false");

    await act(async () => button(messages.solve.overview)!.click());
    expect(board.showMinimap).toBe(true);
  });

  it("asks the board to gather its loose pieces", async () => {
    container.innerHTML = serverHtml();
    await hydrate();

    await act(async () => button(messages.solve.gather)!.click());
    expect(board.gathered).toBe(1);
  });

  describe("the celebration", () => {
    /** The sound toggle; its name stays put, the state is in aria-pressed. */
    function soundToggle() {
      return button(messages.solve.sound);
    }

    it("celebrates the drop that completes the picture, with sound by default", async () => {
      container.innerHTML = serverHtml();
      await hydrate();

      await act(async () => board.onSolved!());
      expect(celebration.celebrate).toHaveBeenCalledTimes(1);
      expect(celebration.celebrate).toHaveBeenCalledWith({ sound: true });
      expect(container.querySelector(".solved-banner")).not.toBeNull();
    });

    it("does not celebrate a puzzle that was already solved when it loaded", async () => {
      // Restoring a finished solve reports a single group, which shows the
      // banner — but nothing was just solved.
      board.groupsFor = () => 1;
      container.innerHTML = serverHtml();
      await hydrate();

      expect(container.querySelector(".solved-banner")).not.toBeNull();
      expect(celebration.celebrate).not.toHaveBeenCalled();
    });

    it("remembers a muted applause across a reload", async () => {
      container.innerHTML = serverHtml();
      await hydrate();

      expect(soundToggle()?.getAttribute("aria-pressed")).toBe("true");
      await act(async () => soundToggle()!.click());
      expect(soundToggle()?.getAttribute("aria-pressed")).toBe("false");
      expect(localStorage.getItem("celebration:sound")).toBe("off");

      await act(async () => root!.unmount());
      root = undefined;
      container.innerHTML = serverHtml();
      await hydrate();

      expect(soundToggle()?.getAttribute("aria-pressed")).toBe("false");
      await act(async () => board.onSolved!());
      expect(celebration.celebrate).toHaveBeenCalledWith({ sound: false });
    });

    it("stops a running celebration when the solver starts over", async () => {
      vi.spyOn(window, "confirm").mockReturnValue(true);
      container.innerHTML = serverHtml();
      await hydrate();
      await act(async () => board.onSolved!());

      celebration.stopCelebration.mockClear();
      await reset();
      expect(celebration.stopCelebration).toHaveBeenCalled();
    });
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

  describe("the stored solve state", () => {
    it("hands the board the state stored for this puzzle", async () => {
      const saved = solveJson(7);
      window.localStorage.setItem(solveKey, saved);
      container.innerHTML = serverHtml();
      await hydrate();

      expect(board.loadSolveState!()).toBe(saved);
    });

    it("hands the board nothing when only another puzzle has a stored state", async () => {
      window.localStorage.setItem("solve:another-puzzle", solveJson(7));
      container.innerHTML = serverHtml();
      await hydrate();

      expect(board.loadSolveState!()).toBeNull();
    });

    it("stores what the board reports after a drop", async () => {
      container.innerHTML = serverHtml();
      await hydrate();

      const raw = solveJson(42);
      await act(async () => board.saveSolveState!(raw));

      expect(window.localStorage.getItem(solveKey)).toBe(raw);
    });

    it("keeps the puzzle playable when localStorage is full", async () => {
      // Only the saving may stop. The board calls this from a Konva drag handler,
      // where an escaping error is uncatchable by any React boundary.
      //
      // Note the spy MUST be on Storage.prototype: jsdom's localStorage is a Proxy
      // that turns property assignment into a stored *item*, so spying on the
      // instance silently installs an entry named "setItem", records no calls, and
      // lets the real write through — a test that can never fail.
      container.innerHTML = serverHtml();
      await hydrate();
      const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new DOMException("full", "QuotaExceededError");
      });

      expect(() => board.saveSolveState!(solveJson(1))).not.toThrow();

      expect(setItem).toHaveBeenCalled();
      expect(progress()).toEqual({ connected: 0, total: CONNECTIONS_108 });
    });

    it("keeps saving once the storage has room again", async () => {
      container.innerHTML = serverHtml();
      await hydrate();
      const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
        throw new DOMException("full", "QuotaExceededError");
      });

      board.saveSolveState!(solveJson(1));
      setItem.mockRestore();
      await act(async () => board.saveSolveState!(solveJson(2)));

      expect(window.localStorage.getItem(solveKey)).toBe(solveJson(2));
    });

    it("keeps the puzzle playable when storage is blocked outright", async () => {
      // Chrome and Firefox throw SecurityError from the `window.localStorage`
      // getter itself when site data is blocked by policy, or inside a sandboxed
      // iframe — so guarding only setItem is not enough. A throw out of the read
      // path is the worse case: it unwinds from an effect, past the board, and
      // (there is no error boundary in this app) replaces the puzzle with an
      // error page.
      const blocked = () => {
        throw new DOMException("denied", "SecurityError");
      };
      for (const method of ["getItem", "setItem", "removeItem", "key"] as const) {
        vi.spyOn(Storage.prototype, method).mockImplementation(blocked);
      }
      vi.spyOn(Storage.prototype, "length", "get").mockImplementation(blocked);
      vi.spyOn(console, "warn").mockImplementation(() => {});

      container.innerHTML = serverHtml();
      await hydrate();

      expect(board.loadSolveState!()).toBeNull();
      expect(() => board.saveSolveState!(solveJson(1))).not.toThrow();
      expect(progress()).toEqual({ connected: 0, total: CONNECTIONS_108 });
    });

    it("drops the least recently updated solve when storing another one", async () => {
      // Otherwise the storage grows for good as more puzzles are opened.
      for (let i = 0; i < MAX_STORED_SOLVES; i++) {
        window.localStorage.setItem(`solve:p-${i}`, solveJson(100 + i));
      }
      window.localStorage.setItem("pc:p-0", "12"); // a neighbour that must survive
      container.innerHTML = serverHtml();
      await hydrate();

      await act(async () => board.saveSolveState!(solveJson(999)));

      expect(window.localStorage.getItem("solve:p-0")).toBeNull();
      expect(window.localStorage.getItem("solve:p-1")).not.toBeNull();
      expect(window.localStorage.getItem(solveKey)).toBe(solveJson(999));
      expect(window.localStorage.getItem("pc:p-0")).toBe("12");
    });

    it("clears the stored state when the piece count changes", async () => {
      vi.spyOn(window, "confirm").mockReturnValue(true);
      window.localStorage.setItem(solveKey, solveJson(7));
      container.innerHTML = serverHtml();
      await hydrate();

      await choose("48");

      expect(window.localStorage.getItem(solveKey)).toBeNull();
    });

    it("asks before a piece-count change discards a solve saved earlier", async () => {
      // `connected` is 0 until the board has built — its chunk, the image and the
      // container width all have to resolve — so a finished puzzle from an earlier
      // visit reads as untouched for the first moments of every visit. Gating the
      // prompt on `connected` alone would delete it without a word.
      board.reportsFor = () => false; // board still loading
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
      window.localStorage.setItem(solveKey, solveJson(7));
      container.innerHTML = serverHtml();
      await hydrate();

      expect(progress()).toEqual({ connected: 0, total: CONNECTIONS_108 });

      await choose("48");

      expect(confirm).toHaveBeenCalledOnce();
      expect(window.localStorage.getItem(solveKey)).toBe(solveJson(7));
      expect(select()?.value).toBe("108");
    });

    it("still does not ask when there is neither progress nor a saved solve", async () => {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
      container.innerHTML = serverHtml();
      await hydrate();

      await choose("48");

      expect(confirm).not.toHaveBeenCalled();
      expect(select()?.value).toBe("48");
    });

    it("keeps the stored state when a piece-count change is declined", async () => {
      board.groupsFor = (total) => total - 3; // three connections made
      vi.spyOn(window, "confirm").mockReturnValue(false);
      const saved = solveJson(7);
      window.localStorage.setItem(solveKey, saved);
      container.innerHTML = serverHtml();
      await hydrate();

      await choose("48");

      expect(window.localStorage.getItem(solveKey)).toBe(saved);
    });
  });

  describe("starting over", () => {
    it("clears the stored state and tells the board to scatter afresh", async () => {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
      window.localStorage.setItem(solveKey, solveJson(7));
      container.innerHTML = serverHtml();
      await hydrate();
      const before = board.resetNonce!;

      await reset();

      expect(confirm).toHaveBeenCalledOnce();
      expect(window.localStorage.getItem(solveKey)).toBeNull();
      expect(board.resetNonce).not.toBe(before);
    });

    it("asks first even on a board with nothing connected yet", async () => {
      // Unlike the piece-count select, this button exists only to throw the board
      // away — and a scatter the solver has been sorting is worth losing too.
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
      window.localStorage.setItem(solveKey, solveJson(7));
      container.innerHTML = serverHtml();
      await hydrate();
      const before = board.resetNonce!;

      await reset();

      expect(confirm).toHaveBeenCalledOnce();
      expect(window.localStorage.getItem(solveKey)).toBe(solveJson(7));
      expect(board.resetNonce).toBe(before);
    });

    it("stops showing the puzzle as solved once it is scattered again", async () => {
      board.groupsFor = () => 1; // solved
      vi.spyOn(window, "confirm").mockReturnValue(true);
      container.innerHTML = serverHtml();
      await hydrate();

      expect(container.querySelector(".solved-banner")).not.toBeNull();

      await reset();

      expect(container.querySelector(".solved-banner")).toBeNull();
      expect(progress()).toEqual({ connected: 0, total: CONNECTIONS_108 });
    });
  });
});
