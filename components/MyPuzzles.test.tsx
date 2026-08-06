import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "@/messages/en.json";
import MyPuzzles from "./MyPuzzles";

// next-intl's Link pulls in next/navigation, which vitest cannot resolve from
// this package's ESM build; the list under test only needs an anchor.
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children, ...rest }: React.ComponentProps<"a">) => (
    <a href={String(href)} {...rest}>
      {children}
    </a>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
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

  it("PATCHes the puzzle and flips the badge on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
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
});
