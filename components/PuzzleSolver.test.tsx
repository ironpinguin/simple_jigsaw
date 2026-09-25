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
  /** The timer plumbing (#118), to drive it like the board does. */
  readTiming: (() => { elapsedMs: number; moves: number } | null) | null;
  onSeeded:
    | ((timing: { elapsedMs: number; moves: number } | null, solved: boolean) => void)
    | null;
  onPieceGrab: (() => void) | null;
  onPieceDrop: (() => void) | null;
  /** How often the solver asked the board to save outside a drop. */
  saves: number;
}>(() => ({
  reportsFor: () => true,
  groupsFor: (total) => total,
  showMinimap: null,
  loadSolveState: null,
  saveSolveState: null,
  resetNonce: null,
  gathered: 0,
  onSolved: null,
  readTiming: null,
  onSeeded: null,
  onPieceGrab: null,
  onPieceDrop: null,
  saves: 0,
}));

// Canvas and Web Audio are beyond jsdom; what matters here is when it is asked.
const celebration = vi.hoisted(() => ({ celebrate: vi.fn(), stopCelebration: vi.fn() }));
vi.mock("./celebrate", () => celebration);

// next-intl's navigation pulls in next/navigation, which vitest cannot resolve
// from this package's ESM build; the solver only renders links from it.
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children, ...rest }: React.ComponentProps<"a">) => (
    <a href={String(href)} {...rest}>
      {children}
    </a>
  ),
}));

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
    readTiming,
    onSeeded,
    onPieceGrab,
    onPieceDrop,
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
    readTiming: () => { elapsedMs: number; moves: number } | null;
    onSeeded: (timing: { elapsedMs: number; moves: number } | null, solved: boolean) => void;
    onPieceGrab: () => void;
    onPieceDrop: () => void;
    actionsRef?: Ref<{ gatherLoose: () => void; save: () => void } | null>;
  }) {
    const total = cols * rows;
    useImperativeHandle(
      actionsRef,
      () => ({ gatherLoose: () => board.gathered++, save: () => board.saves++ }),
      [],
    );
    useEffect(() => {
      board.readTiming = readTiming;
      board.onSeeded = onSeeded;
      board.onPieceGrab = onPieceGrab;
      board.onPieceDrop = onPieceDrop;
    }, [readTiming, onSeeded, onPieceGrab, onPieceDrop]);
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

/** Extra props for every render of a test — the competition ones, mostly. */
let extraProps: Partial<React.ComponentProps<typeof PuzzleSolver>> = {};

function tree(isPublic = true) {
  return (
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <PuzzleSolver puzzle={puzzle} title="Test" isPublic={isPublic} {...extraProps} />
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
    board.readTiming = null;
    board.onSeeded = null;
    board.onPieceGrab = null;
    board.onPieceDrop = null;
    board.saves = 0;
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
      const icons = bar.querySelectorAll(".icon-button");
      // Four toggles plus the help and menu triggers — and not zero, which would
      // pass the loop below without checking anything.
      expect(icons).toHaveLength(6);
      for (const b of icons) {
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

    it("closes the help once focus moves on to the menu button", async () => {
      // Tabbing from one trigger to the next and opening it would otherwise leave
      // both panels open, one on top of the other.
      container.innerHTML = serverHtml();
      await hydrate();

      const help = button(messages.solve.help)!;
      help.focus();
      await act(async () => help.click());
      expect(help.getAttribute("aria-expanded")).toBe("true");

      await act(async () => menuTrigger().focus());
      expect(help.getAttribute("aria-expanded")).toBe("false");
    });

    it("keeps the menu open while focus moves within it", async () => {
      container.innerHTML = serverHtml();
      await hydrate();

      await openMenu();
      menuTrigger().focus();
      await act(async () => button(messages.solve.share)!.focus());
      expect(menuTrigger().getAttribute("aria-expanded")).toBe("true");
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

  describe("the solve timer", () => {
    let visibility: DocumentVisibilityState = "visible";

    beforeEach(() => {
      visibility = "visible";
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => visibility,
      });
      vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
      vi.setSystemTime(1_000_000);
    });

    afterEach(() => {
      vi.useRealTimers();
      Reflect.deleteProperty(document, "visibilityState");
    });

    /** The time the toolbar shows, without the screen-reader label. */
    function shown() {
      return container.querySelector("[role='timer']")?.textContent?.match(/\d+:\d\d(:\d\d)?/)?.[0];
    }

    function card() {
      return container.querySelector(".solve-result")?.textContent ?? null;
    }

    /** Let `ms` pass, ticks and all. */
    function pass(ms: number) {
      return act(async () => {
        vi.advanceTimersByTime(ms);
      });
    }

    async function setVisibility(next: DocumentVisibilityState) {
      visibility = next;
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
    }

    /** Pick a piece up and put it down, `ms` later — one move. */
    async function move(ms = 0) {
      await act(async () => board.onPieceGrab!());
      await pass(ms);
      await act(async () => board.onPieceDrop!());
    }

    /** Seed as the board does: zero for a fresh scatter, `null` for an untimed restore. */
    async function seed(
      timing: { elapsedMs: number; moves: number } | null = { elapsedMs: 0, moves: 0 },
      solved = false,
    ) {
      container.innerHTML = serverHtml();
      await hydrate();
      await act(async () => board.onSeeded!(timing, solved));
    }

    it("waits for the first piece, then counts up", async () => {
      await seed();
      expect(shown()).toBe("0:00");

      await pass(10_000);
      expect(shown()).toBe("0:00");

      await move(7_000);
      await pass(1_000);
      expect(shown()).toBe("0:08");
      expect(board.readTiming!()).toEqual({ elapsedMs: 8_000, moves: 1 });
    });

    it("pauses while the tab is hidden, and saves when it hides", async () => {
      await seed();
      await move(5_000);

      await setVisibility("hidden");
      expect(board.saves).toBe(1);
      await pass(60_000);
      expect(board.readTiming!()?.elapsedMs).toBe(5_000);

      await setVisibility("visible");
      await pass(2_000);
      expect(board.readTiming!()?.elapsedMs).toBe(7_000);
    });

    it("does not save an untouched board when the tab hides", async () => {
      // The saved state is what makes a piece-count change ask first; writing one
      // for a board nobody touched would make it ask for nothing.
      await seed();
      await setVisibility("hidden");
      expect(board.saves).toBe(0);
    });

    it("resumes from the timing stored with a restored solve", async () => {
      await seed({ elapsedMs: 125_000, moves: 30 });
      expect(shown()).toBe("2:05");

      await move(3_000);
      expect(board.readTiming!()).toEqual({ elapsedMs: 128_000, moves: 31 });
    });

    it("shows the time and moves on solve and records them as the best", async () => {
      await seed();
      await move(40_000);
      await move(20_000);
      await act(async () => board.onSolved!());

      expect(card()).toContain("Solved in 1:00 with 2 moves");
      expect(JSON.parse(localStorage.getItem("best:p1")!)).toEqual({
        108: { ms: 60_000, moves: 2 },
      });
      // Saved again once stopped, so a reload shows the time the card did.
      expect(board.saves).toBe(1);

      // Stopped: time passing and the picture being moved change nothing.
      await pass(30_000);
      await move(1_000);
      expect(board.readTiming!()).toEqual({ elapsedMs: 60_000, moves: 2 });
      expect(shown()).toBe("1:00");
    });

    it("says when a solve beats the best time, and shows the best when it does not", async () => {
      localStorage.setItem("best:p1", JSON.stringify({ 108: { ms: 90_000, moves: 50 } }));

      await seed();
      await move(120_000);
      await act(async () => board.onSolved!());
      expect(card()).toContain("Best time: 1:30");

      await act(async () => root!.unmount());
      root = undefined;
      await seed();
      await move(45_000);
      await act(async () => board.onSolved!());
      expect(card()).toContain("New best time! Previously: 1:30");
      expect(JSON.parse(localStorage.getItem("best:p1")!)[108]).toEqual({ ms: 45_000, moves: 1 });
    });

    it("offers the best time for the current piece count in the toolbar", async () => {
      localStorage.setItem("best:p1", JSON.stringify({ 108: { ms: 90_000, moves: 50 } }));
      await seed();
      expect(container.querySelector("[role='timer']")?.getAttribute("title")).toBe(
        "Best time: 1:30",
      );
    });

    it("keeps a restored finished puzzle stopped", async () => {
      board.groupsFor = () => 1;
      await seed({ elapsedMs: 60_000, moves: 9 }, true);
      await move(5_000);
      expect(board.readTiming!()).toEqual({ elapsedMs: 60_000, moves: 9 });
      expect(card()).toBeNull();
    });

    it("neither shows nor records a result for an untimed solve", async () => {
      // Restored from before the timer: no clock ran while its pieces were moved.
      await seed(null);
      await move(3_000);
      await act(async () => board.onSolved!());

      expect(card()).toBeNull();
      expect(localStorage.getItem("best:p1")).toBeNull();
      expect(board.readTiming!()).toBeNull();
      expect(celebration.celebrate).toHaveBeenCalledTimes(1);
    });

    it("pauses and saves when the page is left while the clock runs", async () => {
      // Leaving within the app — a link, the language switch — hides no tab.
      await seed();
      await move(5_000);
      await act(async () => root!.unmount());
      root = undefined;
      expect(board.saves).toBe(1);
    });

    it("does not save an untouched board when the page is left", async () => {
      await seed();
      await act(async () => root!.unmount());
      root = undefined;
      expect(board.saves).toBe(0);
    });

    it("clears the result card on start over", async () => {
      vi.spyOn(window, "confirm").mockReturnValue(true);
      await seed();
      await move(1_000);
      await act(async () => board.onSolved!());
      expect(card()).not.toBeNull();

      await reset();
      expect(card()).toBeNull();
    });

    it("lets the result card be closed", async () => {
      await seed();
      await move(1_000);
      await act(async () => board.onSolved!());
      await act(async () => button(messages.solve.closeResult)!.click());
      expect(card()).toBeNull();
    });
  });

  describe("a competition", () => {
    const COMPETITION = { pieceCount: 12, startsAt: null, endsAt: null };
    let fetchMock: ReturnType<typeof vi.fn>;
    /** What each endpoint answers, by the last path segment. */
    let answers: Record<string, { status: number; body: unknown }>;

    beforeEach(() => {
      extraProps = {
        competition: COMPETITION,
        viewer: { signedIn: true, isAdmin: false },
      };
      answers = {
        start: { status: 200, body: { token: "tok-1" } },
        entries: {
          status: 200,
          body: { improved: true, best: { ms: 60_000, moves: 2 }, rank: 3, displayName: "Fan" },
        },
      };
      fetchMock = vi.fn(async (url: string) => {
        const answer = answers[url.split("/").pop()!] ?? { status: 404, body: {} };
        return { ok: answer.status < 300, status: answer.status, json: async () => answer.body };
      });
      vi.stubGlobal("fetch", fetchMock);
    });

    afterEach(() => {
      extraProps = {};
      vi.unstubAllGlobals();
    });

    function calls(segment: string) {
      return fetchMock.mock.calls.filter(([url]) => String(url).endsWith(`/${segment}`));
    }

    function card() {
      return container.querySelector(".solve-result")?.textContent ?? null;
    }

    async function seed() {
      container.innerHTML = serverHtml();
      await hydrate();
      await act(async () => board.onSeeded!({ elapsedMs: 0, moves: 0 }, false));
    }

    /** Solve by hand: one move, `ms` long, that finishes the puzzle. */
    async function solveIn(ms: number) {
      await act(async () => board.onPieceGrab!());
      await act(async () => {
        vi.advanceTimersByTime(ms);
      });
      await act(async () => board.onPieceDrop!());
      await act(async () => board.onSolved!());
    }

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
      vi.setSystemTime(1_000_000);
    });
    afterEach(() => vi.useRealTimers());

    it("fixes the piece count, ignoring the solver's remembered one", async () => {
      window.localStorage.setItem(storageKey, "108");
      await seed();
      expect(progress().total).toBe(CONNECTIONS_12);
      expect(select()).toBeNull();
    });

    it("starts an attempt on the first piece and enters the finished time", async () => {
      await seed();
      await solveIn(60_000);

      expect(calls("start")).toHaveLength(1);
      const [, init] = calls("entries")[0];
      expect(JSON.parse(String(init.body))).toEqual({
        token: "tok-1",
        ms: 60_000,
        moves: 1,
        pieceCount: 12,
      });
      expect(card()).toContain("Rank 3 on the leaderboard!");
      // Used up with the entry.
      expect(localStorage.getItem("comp:p1")).toBeNull();
    });

    it("asks for a display name once and enters the result with it", async () => {
      answers.entries = {
        status: 409,
        body: { error: "Choose a display name.", code: "displayNameRequired" },
      };
      await seed();
      await solveIn(60_000);
      expect(card()).toContain(messages.competition.chooseDisplayName);

      answers.entries = {
        status: 200,
        body: { improved: true, best: { ms: 60_000, moves: 1 }, rank: 1, displayName: "Fan" },
      };
      const input = container.querySelector<HTMLInputElement>("#result-display-name")!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Fan");
      await act(async () => input.dispatchEvent(new Event("input", { bubbles: true })));
      await act(async () => input.form!.requestSubmit());

      const [, init] = calls("entries")[1];
      expect(JSON.parse(String(init.body))).toMatchObject({ token: "tok-1", displayName: "Fan" });
      expect(card()).toContain("Rank 1 on the leaderboard!");
    });

    it("offers to send a submission again that failed in transit", async () => {
      await seed();
      // The first answer never arrives; the second one does.
      fetchMock.mockImplementationOnce(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ token: "tok-1" }),
      }));
      fetchMock.mockImplementationOnce(async () => {
        throw new TypeError("network down");
      });
      vi.spyOn(console, "error").mockImplementation(() => {});
      await solveIn(60_000);
      expect(card()).toContain(messages.competition.entryFailed);

      await act(async () => button(messages.competition.retry)!.click());

      const [first, second] = calls("entries");
      expect(second[1].body).toBe(first[1].body);
      expect(card()).toContain("Rank 3 on the leaderboard!");
    });

    it("does not offer to retry a submission the server refused", async () => {
      answers.entries = { status: 422, body: { error: "This time is not plausible." } };
      await seed();
      await solveIn(60_000);
      expect(card()).toContain("This time is not plausible.");
      expect(button(messages.competition.retry)).toBeUndefined();
    });

    it("does not send an attempt the server never started", async () => {
      answers.start = { status: 409, body: { error: "not open" } };
      await seed();
      await solveIn(60_000);
      expect(calls("entries")).toHaveLength(0);
      expect(card()).toContain(messages.competition.notCounted);
    });

    it("invites a signed-out solver to sign in instead of submitting", async () => {
      extraProps = { competition: COMPETITION, viewer: { signedIn: false, isAdmin: false } };
      await seed();
      await solveIn(60_000);
      expect(calls("start")).toHaveLength(0);
      expect(calls("entries")).toHaveLength(0);
      expect(container.querySelector(".solve-result a")?.getAttribute("href")).toBe(
        "/login?callbackUrl=/puzzle/p1",
      );
    });

    it("says nothing about taking part once the competition has ended", async () => {
      extraProps = {
        competition: { ...COMPETITION, endsAt: new Date(0).toISOString() },
        viewer: { signedIn: false, isAdmin: false },
      };
      await seed();
      await solveIn(60_000);
      expect(container.querySelector(".solve-result a")).toBeNull();
      expect(card()).not.toContain(messages.competition.notCounted);
    });

    it("does not bring back a closed card when the entry lands afterwards", async () => {
      let land!: () => void;
      const landed = new Promise<void>((resolve) => (land = resolve));
      const answer = fetchMock.getMockImplementation() as (url: string) => Promise<unknown>;
      fetchMock.mockImplementation(async (url: string) => {
        if (String(url).endsWith("/entries")) await landed;
        return answer(url);
      });
      await seed();
      await solveIn(60_000);
      const close = container.querySelector<HTMLButtonElement>(
        `.solve-result button[aria-label="${messages.solve.closeResult}"]`,
      )!;
      await act(async () => close.click());
      await act(async () => land());
      expect(card()).toBeNull();
    });

    it("keeps the attempt across a reload in the middle of the solve", async () => {
      await seed();
      await act(async () => board.onPieceGrab!());
      expect(localStorage.getItem("comp:p1")).toBe("tok-1");

      await act(async () => root!.unmount());
      root = undefined;
      container.innerHTML = serverHtml();
      await hydrate();
      await act(async () => board.onSeeded!({ elapsedMs: 5_000, moves: 3 }, false));
      expect(localStorage.getItem("comp:p1")).toBe("tok-1");
    });

    it("drops the attempt on start over", async () => {
      vi.spyOn(window, "confirm").mockReturnValue(true);
      await seed();
      await act(async () => board.onPieceGrab!());
      await reset();
      expect(localStorage.getItem("comp:p1")).toBeNull();
    });

    it("shows the leaderboard button only when there is a competition", async () => {
      await seed();
      expect(button(messages.competition.leaderboard)).toBeDefined();

      await act(async () => root!.unmount());
      root = undefined;
      extraProps = {};
      container.innerHTML = serverHtml();
      await hydrate();
      expect(button(messages.competition.leaderboard)).toBeUndefined();
    });
  });
});
