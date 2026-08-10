import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "@/messages/en.json";
import CreateForm from "./CreateForm";

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));

// next-intl's Link pulls in next/navigation, which vitest cannot resolve from
// this package's ESM build; the form under test only needs the router.
vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);

  // jsdom has no object URLs; the preview effect only needs it to not throw.
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:jigsaw/preview"),
    revokeObjectURL: vi.fn(),
  });

  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function mount() {
  act(() => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <CreateForm />
      </NextIntlClientProvider>,
    );
  });
}

/**
 * Stub the two-step create flow: the upload always succeeds, and the
 * subsequent POST to /api/puzzles answers with `puzzleResponse`.
 */
function respondToCreateWith(puzzleResponse: Record<string, unknown>) {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url === "/api/upload") {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ imageKey: "puzzles/abc.webp", width: 800, height: 600 }),
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => puzzleResponse });
  });
  vi.stubGlobal("fetch", fetchMock);
}

/** Pick a file and submit — the only path that reaches the navigation call. */
async function submitForm() {
  mount();
  const fileInput = container.querySelector<HTMLInputElement>("#file")!;
  const file = new File(["data"], "photo.png", { type: "image/png" });
  await act(async () => {
    Object.defineProperty(fileInput, "files", { value: [file] });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const form = container.querySelector("form")!;
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("CreateForm success navigation", () => {
  it("sends the uploader to the review note when the puzzle is held back", async () => {
    // Without it the puzzle is simply missing from the public list and the user
    // reads that as a bug — and uploads it again.
    respondToCreateWith({ id: "puzzle-1", pendingReview: true });

    await submitForm();

    expect(pushMock).toHaveBeenCalledWith("/puzzle/puzzle-1?review=1");
  });

  it("goes straight to the puzzle when nothing was flagged", async () => {
    respondToCreateWith({ id: "puzzle-1", pendingReview: false });

    await submitForm();

    expect(pushMock).toHaveBeenCalledWith("/puzzle/puzzle-1");
  });
});
