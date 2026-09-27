import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "@/messages/en.json";
import MyPuzzles from "./MyPuzzles";
import SolvedPuzzles from "./SolvedPuzzles";

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));

// next-intl's Link pulls in next/navigation, which vitest cannot resolve from
// this package's ESM build; the list under test only needs an anchor.
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children, ...rest }: React.ComponentProps<"a">) => (
    <a href={String(href)} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ push: pushMock }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const PUZZLE = {
  id: "p1",
  title: "Beach",
  imageKey: "puzzles/abc.webp",
  pieceCount: 48,
  isPublic: false,
  competition: null,
  bests: [] as { pieceCount: number; ms: number; moves: number }[],
};

function mount(initial = [PUZZLE]) {
  act(() => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <MyPuzzles initial={initial} />
      </NextIntlClientProvider>,
    );
  });
}

function buttonByText(text: string) {
  return [...container.querySelectorAll("button")].find((b) => b.textContent === text);
}

describe("MyPuzzles visibility toggle", () => {
  it("shows the private state and a make-public action", () => {
    mount();
    expect(container.textContent).toContain("Private");
    expect(buttonByText("Make public")).toBeTruthy();
  });

  it("PATCHes the puzzle and flips the badge to the state the server confirms", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ puzzle: { id: "p1", isPublic: true } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    mount();

    await act(async () => {
      buttonByText("Make public")!.click();
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/puzzles/p1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isPublic: true }),
    });
    expect(container.textContent).toContain("Public");
    expect(buttonByText("Make private")).toBeTruthy();
  });

  it("swaps the thumbnail to the rotated imageKey when making a puzzle private", async () => {
    // Flipping to private rotates the imageKey server-side; the old key
    // answers 404 from then on, so the tile must re-render with the new one.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          puzzle: { id: "p1", isPublic: false, imageKey: "puzzles/rotated.webp" },
        }),
      }),
    );
    mount([{ ...PUZZLE, isPublic: true }]);

    await act(async () => {
      buttonByText("Make private")!.click();
    });

    expect(container.querySelector("img")!.getAttribute("src")).toBe(
      "/api/image/puzzles/rotated.webp",
    );
    expect(container.textContent).toContain("Private");
  });

  it("keeps the badge and surfaces the server's error when the PATCH is rejected", async () => {
    const alertMock = vi.fn();
    vi.stubGlobal("alert", alertMock);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ error: "Puzzle not found." }),
      }),
    );
    mount();

    await act(async () => {
      buttonByText("Make public")!.click();
    });

    expect(container.textContent).toContain("Private");
    expect(alertMock).toHaveBeenCalledWith("Puzzle not found.");
    expect(buttonByText("Make public")!.disabled).toBe(false);
  });

  it("redirects to login when the session has expired", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }),
    );
    mount();

    await act(async () => {
      buttonByText("Make public")!.click();
    });

    expect(pushMock).toHaveBeenCalledWith("/login?callbackUrl=/my");
    expect(container.textContent).toContain("Private");
  });

  it("alerts and re-enables the buttons when the request itself fails", async () => {
    const alertMock = vi.fn();
    vi.stubGlobal("alert", alertMock);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    mount();

    await act(async () => {
      buttonByText("Make public")!.click();
    });

    expect(container.textContent).toContain("Private");
    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(buttonByText("Make public")!.disabled).toBe(false);
    expect(buttonByText("Delete")!.disabled).toBe(false);
  });
});

describe("MyPuzzles delete", () => {
  it("alerts and re-enables the buttons when the request itself fails", async () => {
    const alertMock = vi.fn();
    vi.stubGlobal("alert", alertMock);
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    mount();

    await act(async () => {
      buttonByText("Delete")!.click();
    });

    expect(container.textContent).toContain("Beach");
    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(buttonByText("Delete")!.disabled).toBe(false);
  });
});

describe("best times under My puzzles (#127)", () => {
  it("lists the owner's own best times in the puzzle card, smallest count first", () => {
    mount([
      {
        ...PUZZLE,
        bests: [
          { pieceCount: 108, ms: 725_000, moves: 310 },
          { pieceCount: 12, ms: 83_000, moves: 1 },
        ],
      },
    ]);
    const items = [...container.querySelectorAll(".best-times li")].map((li) => li.textContent);
    expect(items).toEqual(["12 pieces: 1:23 (1 move)", "108 pieces: 12:05 (310 moves)"]);
    expect(container.textContent).toContain(messages.my.bestTimes);
  });

  it("shows no best-times block for a puzzle without any", () => {
    mount();
    expect(container.querySelector(".best-times")).toBeNull();
  });

  it("gives other people's solved puzzles a section of their own", () => {
    act(() => {
      root.render(
        <NextIntlClientProvider locale="en" messages={messages}>
          <SolvedPuzzles
            puzzles={[
              {
                id: "p9",
                title: "Their beach",
                imageKey: "puzzles/x.webp",
                bests: [{ pieceCount: 48, ms: 300_000, moves: 90 }],
              },
            ]}
          />
        </NextIntlClientProvider>,
      );
    });
    expect(container.querySelector("h2")!.textContent).toBe(messages.my.solvedTitle);
    expect(container.textContent).toContain("48 pieces: 5:00 (90 moves)");
    const link = [...container.querySelectorAll("a")].find((a) => a.textContent === messages.my.solveAgain)!;
    expect(link.getAttribute("href")).toBe("/puzzle/p9");
  });

  it("leaves the section out when there is nothing to show", () => {
    act(() => {
      root.render(
        <NextIntlClientProvider locale="en" messages={messages}>
          <SolvedPuzzles puzzles={[]} />
        </NextIntlClientProvider>,
      );
    });
    expect(container.innerHTML).toBe("");
  });
});
