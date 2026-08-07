import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "@/messages/en.json";
import ReportDialog from "./ReportDialog";

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

function mount() {
  act(() => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ReportDialog puzzleId="p1" />
      </NextIntlClientProvider>,
    );
  });
}

function buttonByText(text: string) {
  return [...container.querySelectorAll("button")].find((b) => b.textContent === text);
}

// React reads inputs through the native value setter, so a plain `.value =`
// assignment does not trigger onChange — go through the prototype setter.
function setValue(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function openAndFill(message: string) {
  act(() => buttonByText(messages.report.reportLink)!.click());
  act(() => setValue(container.querySelector("textarea")!, message));
}

describe("ReportDialog", () => {
  it("keeps submit disabled until the message is long enough", () => {
    mount();
    openAndFill("short");
    expect(buttonByText(messages.report.submit)!.disabled).toBe(true);
  });

  it("submits the report and shows the confirmation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    mount();
    openAndFill("This image is sexually explicit.");
    await act(async () => buttonByText(messages.report.submit)!.click());

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/report",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({
      puzzleId: "p1",
      category: "NSFW",
      message: "This image is sexually explicit.",
    });
    expect(container.textContent).toContain(messages.report.doneText);
  });

  it("shows the server's error message on a non-429 failure and allows a retry", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: "The puzzle was not found." }), { status: 404 }),
        ),
    );
    mount();
    openAndFill("This image is sexually explicit.");
    await act(async () => buttonByText(messages.report.submit)!.click());

    // The API answers with a localized, specific message — show it instead of
    // a generic "try again later" that a retry can never fix.
    expect(container.textContent).toContain("The puzzle was not found.");
    expect(buttonByText(messages.report.submit)!.disabled).toBe(false);
  });

  it("falls back to the generic message when the failure has no readable body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("oops", { status: 500 })),
    );
    mount();
    openAndFill("This image is sexually explicit.");
    await act(async () => buttonByText(messages.report.submit)!.click());
    expect(container.textContent).toContain(messages.report.failed);
  });

  it("shows the generic message and stays retryable when the request itself fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    mount();
    openAndFill("This image is sexually explicit.");
    await act(async () => buttonByText(messages.report.submit)!.click());
    expect(container.textContent).toContain(messages.report.failed);
    expect(buttonByText(messages.report.submit)!.disabled).toBe(false);
    errorSpy.mockRestore();
  });

  it("shows the rate-limit message on a 429", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "x" }), { status: 429 })),
    );
    mount();
    openAndFill("This image is sexually explicit.");
    await act(async () => buttonByText(messages.report.submit)!.click());
    expect(container.textContent).toContain(messages.report.tooMany);
  });
});
