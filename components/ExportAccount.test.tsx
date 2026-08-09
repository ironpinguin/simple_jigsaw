import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "@/messages/en.json";
import itMessages from "@/messages/it.json";
import ExportAccount from "./ExportAccount";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let createdUrl: string | null;
let revoked: string[];
let clicked: HTMLAnchorElement[];

beforeEach(() => {
  vi.clearAllMocks();
  createdUrl = null;
  revoked = [];
  clicked = [];

  // jsdom has no object URLs and no real downloads; record what the component
  // asks the browser to do instead.
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => {
      createdUrl = "blob:jigsaw/export";
      return createdUrl;
    }),
    revokeObjectURL: vi.fn((url: string) => revoked.push(url)),
  });

  const realClick = HTMLAnchorElement.prototype.click;
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked.push(this);
  });
  void realClick;

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

function mountWith(locale: "en" | "it") {
  act(() => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === "it" ? itMessages : messages}>
        <ExportAccount />
      </NextIntlClientProvider>,
    );
  });
}

const mount = () => mountWith("en");

const button = () => container.querySelector("button") as HTMLButtonElement;

function respondWith(init: { ok: boolean; status?: number; body?: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: init.ok,
      status: init.status ?? (init.ok ? 200 : 500),
      blob: async () => new Blob([JSON.stringify(init.body ?? {})], { type: "application/json" }),
      json: async () => init.body ?? null,
    })),
  );
}

async function clickExport() {
  await act(async () => {
    button().dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("ExportAccount", () => {
  it("offers the download", () => {
    mount();

    expect(container.textContent).toContain("Download my data");
    expect(button().textContent).toContain("Download data");
  });

  it("asks the export endpoint for the file", async () => {
    respondWith({ ok: true, body: { account: {} } });
    mount();

    await clickExport();

    expect(fetch).toHaveBeenCalledWith("/api/account/export");
  });

  it("saves the payload as a file instead of navigating to it", async () => {
    // A plain link would leave the user staring at raw JSON in a tab when the
    // browser decides to render it.
    respondWith({ ok: true, body: { account: {} } });
    mount();

    await clickExport();

    expect(createdUrl).toBe("blob:jigsaw/export");
    expect(clicked).toHaveLength(1);
    expect(clicked[0].download).toMatch(/\.json$/);
  });

  it("releases the object URL once the download has started", async () => {
    // Otherwise the blob is pinned in memory for the life of the page.
    respondWith({ ok: true, body: { account: {} } });
    mount();

    await clickExport();

    expect(revoked).toEqual(["blob:jigsaw/export"]);
  });

  it("shows the server's message when the export is refused", async () => {
    // 429 is the one a user can actually act on — they just have to wait.
    respondWith({ ok: false, status: 429, body: { error: "Too many requests." } });
    mount();

    await clickExport();

    expect(container.textContent).toContain("Too many requests.");
    expect(clicked).toHaveLength(0);
  });

  it("falls back to its own wording when the server sends none", async () => {
    respondWith({ ok: false, status: 500, body: null });
    mount();

    await clickExport();

    expect(container.textContent).toContain("Download failed.");
  });

  it("reports a network failure instead of looking like it worked", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      }),
    );
    mount();

    await clickExport();

    expect(container.textContent).toContain("Download failed.");
    expect(logged).toHaveBeenCalled();
  });

  it("recovers when the file arrives but cannot be saved", async () => {
    // The request succeeded and the body then failed to read — an interrupted
    // download of a large account. Without a handler the button stays disabled
    // on "Collecting your data…" with no message, and only a reload clears it.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        blob: async () => {
          throw new TypeError("network error");
        },
        json: async () => null,
      })),
    );
    mount();

    await clickExport();

    expect(container.textContent).toContain("Download failed.");
    expect(button().disabled).toBe(false);
    expect(button().textContent).toContain("Download data");
    expect(logged).toHaveBeenCalled();
  });

  it("lets the user try again after a failure", async () => {
    respondWith({ ok: false, status: 500, body: null });
    mount();
    await clickExport();

    expect(button().disabled).toBe(false);
  });

  it("speaks the active locale", async () => {
    respondWith({ ok: false, status: 500, body: null });
    mountWith("it");

    await clickExport();

    expect(container.textContent).toContain("Download non riuscito.");
  });
});
