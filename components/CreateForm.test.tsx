import { act, StrictMode } from "react";
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

  // jsdom has no object URLs. A *unique* one per call, as the browser gives:
  // a constant would make any assertion about revoking the previous URL pass or
  // fail for the wrong reason, since an effect keyed on the URL would never see
  // it change.
  let issued = 0;
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => `blob:jigsaw/preview-${++issued}`),
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

/** Choose (or clear) the file input and let the effects settle. */
async function chooseFile(file: File | null) {
  const fileInput = container.querySelector<HTMLInputElement>("#file")!;
  await act(async () => {
    Object.defineProperty(fileInput, "files", {
      value: file ? [file] : [],
      configurable: true,
    });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

const preview = () => container.querySelector<HTMLImageElement>("img");

describe("CreateForm image preview", () => {
  it("shows no preview before a file is chosen, and asks for no object URL", () => {
    // The empty form is the first render every visitor sees; it must not create
    // an object URL it would then have to revoke.
    mount();
    expect(preview()).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("previews the chosen file through an object URL", async () => {
    mount();
    await chooseFile(new File(["data"], "photo.png", { type: "image/png" }));

    expect(preview()?.getAttribute("src")).toBe("blob:jigsaw/preview-1");
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("drops the preview and revokes the URL when the file is cleared", async () => {
    // The leak this guards is not hypothetical: an object URL lives until it is
    // revoked or the document goes away.
    mount();
    await chooseFile(new File(["data"], "photo.png", { type: "image/png" }));
    await chooseFile(null);

    expect(preview()).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:jigsaw/preview-1");
  });

  it("revokes the previous URL when a second file replaces the first", async () => {
    mount();
    await chooseFile(new File(["a"], "one.png", { type: "image/png" }));
    await chooseFile(new File(["b"], "two.png", { type: "image/png" }));

    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
    expect(preview()).not.toBeNull();
  });

  it("revokes the URL when the form unmounts with a file still chosen", async () => {
    mount();
    await chooseFile(new File(["data"], "photo.png", { type: "image/png" }));

    act(() => root.unmount());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:jigsaw/preview-1");

    // afterEach unmounts again; give it a live root to unmount.
    root = createRoot(container);
  });
});

describe("CreateForm object URL accounting", () => {
  // The reason components/CreateForm.tsx carries a scoped disable for
  // react-hooks/set-state-in-effect (#84). The rule wants the preview URL
  // derived rather than set from an effect, and the obvious derivation —
  //
  //   const previewUrl = useMemo(() => file && URL.createObjectURL(file), [file]);
  //
  // lints clean and passes every other test in this file. It also leaks: React
  // may run a memo more than once for a render it keeps only one result of, and
  // the effect that revokes only ever sees the surviving value. Measured under
  // StrictMode, which double-renders on purpose to surface exactly this, the
  // memo version created 6 URLs and revoked 3.
  //
  // So this asserts the accounting rather than the implementation: every URL
  // handed out is handed back. Anything that satisfies that is welcome to
  // replace the effect.
  it("revokes every URL it creates, including under StrictMode", async () => {
    let issued = 0;
    const created: string[] = [];
    const revoked: string[] = [];
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => {
        const url = `blob:jigsaw/strict-${++issued}`;
        created.push(url);
        return url;
      }),
      revokeObjectURL: vi.fn((url: string) => revoked.push(url)),
    });

    const strictRoot = createRoot(container);
    act(() => {
      strictRoot.render(
        <StrictMode>
          <NextIntlClientProvider locale="en" messages={messages}>
            <CreateForm />
          </NextIntlClientProvider>
        </StrictMode>,
      );
    });

    const input = container.querySelector<HTMLInputElement>("#file")!;
    for (const name of ["one.png", "two.png", "three.png"]) {
      await act(async () => {
        Object.defineProperty(input, "files", {
          value: [new File(["d"], name, { type: "image/png" })],
          configurable: true,
        });
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }
    act(() => strictRoot.unmount());

    expect(created.length).toBeGreaterThan(0);
    expect(created.filter((url) => !revoked.includes(url))).toEqual([]);
  });
});

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
