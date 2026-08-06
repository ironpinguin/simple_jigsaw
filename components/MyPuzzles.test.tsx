import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "@/messages/en.json";
import MyPuzzles from "./MyPuzzles";

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
};

function mount() {
  act(() => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <MyPuzzles initial={[PUZZLE]} />
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
