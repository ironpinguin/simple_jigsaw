import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "@/messages/en.json";
import CompetitionSettings, { type OwnerCompetition } from "./CompetitionSettings";

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));
vi.mock("@/i18n/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));

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
  vi.restoreAllMocks();
});

function mount(initial: OwnerCompetition | null, isPublic = true) {
  act(() => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <CompetitionSettings
          puzzleId="p1"
          isPublic={isPublic}
          defaultPieceCount={48}
          initial={initial}
        />
      </NextIntlClientProvider>,
    );
  });
}

const button = (text: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === text);

function respond(status: number, body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const t = messages.competition;

describe("CompetitionSettings", () => {
  it("starts a competition with the puzzle's piece count and no window", async () => {
    const fetchMock = respond(200, {
      competition: { pieceCount: 48, startsAt: null, endsAt: null },
    });
    mount(null);

    act(() => button(t.start)!.click());
    await act(async () => {
      container.querySelector("form")!.requestSubmit();
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/puzzles/p1/competition", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pieceCount: 48, startsAt: null, endsAt: null }),
    });
    expect(container.textContent).toContain(t.running);
    expect(container.querySelector("form")).toBeNull();
  });

  it("is not offered on a private puzzle", () => {
    mount(null, false);
    expect(button(t.start)!.disabled).toBe(true);
    expect(container.textContent).toContain(t.needsPublic);
  });

  it("can still be ended after the puzzle went private", () => {
    mount({ pieceCount: 12, startsAt: null, endsAt: null, entries: 0 }, false);
    expect(button(t.edit)!.disabled).toBe(false);
    act(() => button(t.edit)!.click());
    expect(button(t.end)).toBeTruthy();
  });

  it("locks the piece count once there are entries", () => {
    mount({ pieceCount: 12, startsAt: null, endsAt: null, entries: 3 });
    expect(container.textContent).toContain("3 entries");
    act(() => button(t.edit)!.click());
    expect(container.querySelector("select")!.disabled).toBe(true);
    expect(container.textContent).toContain(t.countLocked);
  });

  it("shows the API's reason when saving fails", async () => {
    respond(409, { error: "Only a public puzzle can be a competition." });
    mount(null);
    act(() => button(t.start)!.click());
    await act(async () => {
      container.querySelector("form")!.requestSubmit();
    });
    expect(container.querySelector(".error")!.textContent).toBe(
      "Only a public puzzle can be a competition.",
    );
  });

  it("ends the competition after confirming, and keeps it with its result", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const fetchMock = respond(200, {
      competition: { pieceCount: 12, startsAt: null, endsAt: "2026-09-27T12:00:00.000Z" },
    });
    mount({ pieceCount: 12, startsAt: null, endsAt: null, entries: 4 });

    act(() => button(t.edit)!.click());
    await act(async () => button(t.end)!.click());

    expect(fetchMock).toHaveBeenCalledWith("/api/puzzles/p1/competition/end", { method: "POST" });
    expect(container.textContent).toContain("Competition ended on");
    expect(container.textContent).toContain("4 entries");
    expect(button(t.showLeaderboard)).toBeTruthy();
  });

  it("does not end it when the owner declines", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const fetchMock = respond(200, {});
    mount({ pieceCount: 12, startsAt: null, endsAt: null, entries: 0 });

    act(() => button(t.edit)!.click());
    await act(async () => button(t.end)!.click());

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("offers deleting instead of ending once it is over, and says how to reopen it", () => {
    mount({ pieceCount: 12, startsAt: null, endsAt: "2026-01-01T00:00:00.000Z", entries: 2 });

    act(() => button(t.edit)!.click());

    expect(button(t.end)).toBeUndefined();
    expect(button(t.delete)).toBeTruthy();
    expect(container.textContent).toContain(t.endedHint);
  });

  it("deletes the competition and its leaderboard after confirming", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const fetchMock = respond(200, { ok: true });
    mount({ pieceCount: 12, startsAt: null, endsAt: "2026-01-01T00:00:00.000Z", entries: 2 });

    act(() => button(t.edit)!.click());
    await act(async () => button(t.delete)!.click());

    expect(confirm).toHaveBeenCalledWith(t.confirmDelete);
    expect(fetchMock).toHaveBeenCalledWith("/api/puzzles/p1/competition", { method: "DELETE" });
    expect(button(t.start)).toBeTruthy();
    expect(button(t.showLeaderboard)).toBeUndefined();
  });

  it("shows the leaderboard on demand, running or ended", async () => {
    const fetchMock = respond(200, {
      competition: { pieceCount: 12, startsAt: null, endsAt: null, phase: "OPEN" },
      entries: [
        { id: "e1", rank: 1, displayName: "Ana", ms: 61_000, moves: 20, achievedAt: "2026-09-20T08:00:00.000Z", isYou: false },
      ],
      you: null,
    });
    mount({ pieceCount: 12, startsAt: null, endsAt: null, entries: 1 });
    expect(container.querySelector(".leaderboard")).toBeNull();

    await act(async () => button(t.showLeaderboard)!.click());

    expect(fetchMock).toHaveBeenCalledWith("/api/competitions/p1", undefined);
    expect(container.querySelector(".leaderboard")!.textContent).toContain("Ana");
    expect(button(t.hideLeaderboard)!.getAttribute("aria-expanded")).toBe("true");
  });

  it("links the CSV download of the whole leaderboard", () => {
    mount({ pieceCount: 12, startsAt: null, endsAt: null, entries: 1 });
    const link = [...container.querySelectorAll("a")].find((a) => a.textContent?.includes(t.downloadCsv))!;
    expect(link.getAttribute("href")).toBe("/api/puzzles/p1/competition/leaderboard");
    expect(link.hasAttribute("download")).toBe(true);
  });

  it("offers neither leaderboard nor download without a competition", () => {
    mount(null);
    expect(button(t.showLeaderboard)).toBeUndefined();
    expect(container.querySelector("a")).toBeNull();
  });

  it("summarises an upcoming competition by its start", () => {
    mount({ pieceCount: 12, startsAt: "2999-01-01T10:00:00.000Z", endsAt: null, entries: 0 });
    expect(container.textContent).toContain("Competition from");
  });
});
