import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "@/messages/en.json";
import Leaderboard from "./Leaderboard";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children }: React.ComponentProps<"a">) => <a href={String(href)}>{children}</a>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const BOARD = {
  competition: { pieceCount: 48, startsAt: null, endsAt: null, phase: "OPEN" },
  entries: [
    { id: "e1", rank: 1, displayName: "Ana", ms: 61_000, moves: 40, achievedAt: "", isYou: false },
    { id: "e2", rank: 2, displayName: "Ben", ms: 75_000, moves: 52, achievedAt: "", isYou: true },
  ],
  you: { rank: 2, ms: 75_000, moves: 52 },
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => BOARD }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mount(props: Partial<React.ComponentProps<typeof Leaderboard>> = {}) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <Leaderboard
          puzzleId="p1"
          active
          version={0}
          signedIn
          isAdmin={false}
          {...props}
        />
      </NextIntlClientProvider>,
    );
  });
}

describe("Leaderboard", () => {
  it("does not load until it is shown", async () => {
    await mount({ active: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lists places, times and marks the viewer", async () => {
    await mount();
    expect(fetchMock).toHaveBeenCalledWith("/api/competitions/p1", undefined);
    const rows = [...container.querySelectorAll("li")].map((li) => li.textContent);
    expect(rows[0]).toContain("1.Ana1:0140 moves");
    expect(rows[1]).toContain("(you)");
    expect(container.textContent).toContain("48 pieces (competition)");
  });

  it("loads again when the solver's entry changed the board", async () => {
    await mount();
    await mount({ version: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("lets an admin remove an entry, then reloads", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await mount({ isAdmin: true });
    const remove = container.querySelector<HTMLButtonElement>('[aria-label="Remove Ana\'s entry"]')!;
    await act(async () => remove.click());
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/leaderboard/e1", { method: "DELETE" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("offers no remove button to anyone else", async () => {
    await mount();
    expect(container.querySelector("li button")).toBeNull();
  });

  it("invites a signed-out visitor to sign in", async () => {
    await mount({ signedIn: false });
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/login?callbackUrl=/puzzle/p1");
  });
});
