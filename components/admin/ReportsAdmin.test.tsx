import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "@/messages/en.json";
import ReportsAdmin, { type ReportRow } from "./ReportsAdmin";

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

const OPEN: ReportRow = {
  id: "r1",
  puzzleId: "pz1",
  puzzleTitle: "Beach",
  category: "NSFW",
  message: "This image is sexually explicit.",
  reporterEmail: "me@example.com",
  status: "OPEN",
  createdAt: "2026-08-07T10:00:00.000Z",
  resolvedAt: null,
  puzzleExists: true,
};

function mount(open: ReportRow[] = [OPEN], resolved: ReportRow[] = []) {
  act(() => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ReportsAdmin initialOpen={open} initialResolved={resolved} />
      </NextIntlClientProvider>,
    );
  });
}

function buttonByText(text: string) {
  return [...container.querySelectorAll("button")].find((b) => b.textContent === text);
}

describe("ReportsAdmin", () => {
  it("dismisses a report and moves it to the resolved list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
    mount();
    await act(async () => buttonByText(messages.admin.dismiss)!.click());

    expect(fetch).toHaveBeenCalledWith(
      "/api/admin/reports/r1",
      expect.objectContaining({ method: "PATCH" }),
    );
    expect(container.textContent).toContain(messages.admin.reportsEmpty);
    expect(container.textContent).toContain(messages.admin.decisionDismissed);
  });

  it("takes a puzzle down after confirmation and resolves all its reports", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
    const second: ReportRow = { ...OPEN, id: "r2", reporterEmail: null };
    mount([OPEN, second]);
    await act(async () => buttonByText(messages.admin.takedown)!.click());

    expect(fetch).toHaveBeenCalledWith(
      "/api/admin/puzzles/pz1",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(container.textContent).toContain(messages.admin.reportsEmpty);
    // Both open reports of the same puzzle moved to resolved.
    expect(container.textContent.match(new RegExp(messages.admin.decisionTakedown, "g"))).toHaveLength(2);
  });

  it("does not call the API when the confirmation is declined", async () => {
    vi.stubGlobal("confirm", vi.fn(() => false));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mount();
    await act(async () => buttonByText(messages.admin.takedown)!.click());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("offers no takedown for a report whose puzzle is already gone", () => {
    mount([{ ...OPEN, puzzleExists: false }]);
    expect(buttonByText(messages.admin.takedown)).toBeUndefined();
    expect(buttonByText(messages.admin.dismiss)).toBeDefined();
    expect(container.textContent).toContain(messages.admin.reportPuzzleDeleted);
  });
});
