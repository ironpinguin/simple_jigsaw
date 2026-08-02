/** @vitest-environment jsdom */
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "@/messages/en.json";
import PuzzleSolver from "./PuzzleSolver";

// The real board pulls in Konva, which needs a canvas jsdom does not provide.
// Nothing here depends on what it draws.
vi.mock("./PuzzleBoard", () => ({
  default: () => null,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const puzzle = {
  id: "p1",
  imageKey: "key.webp",
  imageWidth: 1200,
  imageHeight: 800,
  pieceCount: 108, // the creator's default
  seed: 1,
};

function tree() {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      <PuzzleSolver puzzle={puzzle} title="Test" />
    </NextIntlClientProvider>
  );
}

/** Render as the server does: no `window`, so no access to localStorage. */
function serverHtml() {
  const realWindow = globalThis.window;
  // @ts-expect-error — deliberately emulating the server environment
  delete globalThis.window;
  try {
    return renderToString(tree());
  } finally {
    globalThis.window = realWindow;
  }
}

describe("PuzzleSolver", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    vi.restoreAllMocks();
  });

  it("hydrates without a mismatch when a piece count was remembered", async () => {
    window.localStorage.setItem(`pc:${puzzle.id}`, "12");
    container.innerHTML = serverHtml();

    // React reports a mismatch twice: as a recoverable error and on the console.
    const onRecoverableError = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => {
      hydrateRoot(container, tree(), { onRecoverableError });
    });

    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("applies the remembered piece count after mount", async () => {
    window.localStorage.setItem(`pc:${puzzle.id}`, "12");
    container.innerHTML = serverHtml();

    // 108 pieces → 12 × 9, so 107 connections before the stored value lands.
    expect(container.querySelector(".progress")?.textContent).toContain("/ 107");

    await act(async () => {
      hydrateRoot(container, tree());
    });

    // 12 pieces → 4 × 3, so 11 connections.
    expect(container.querySelector(".progress")?.textContent).toContain("/ 11");
    expect(container.querySelector<HTMLSelectElement>("#piece-count")?.value).toBe("12");
  });

  it("ignores a stored value that is not a preset", async () => {
    window.localStorage.setItem(`pc:${puzzle.id}`, "7");
    container.innerHTML = serverHtml();

    await act(async () => {
      hydrateRoot(container, tree());
    });

    expect(container.querySelector<HTMLSelectElement>("#piece-count")?.value).toBe("108");
  });
});
