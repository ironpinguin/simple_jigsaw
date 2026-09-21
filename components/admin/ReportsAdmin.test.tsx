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
  // Deliberately the far side of midnight from the suite's zone (see the
  // components project in vitest.config.ts): 02:30 UTC is the previous day in
  // America/New_York, so a call site that formats in the runtime's zone renders
  // "Aug 6" and the assertions below fail (#55).
  createdAt: "2026-08-07T02:30:00.000Z",
  resolvedAt: null,
  puzzleExists: true,
};

function mount(open: ReportRow[] = [OPEN], resolved: ReportRow[] = [], locale = "en") {
  act(() => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={messages}>
        <ReportsAdmin initialOpen={open} initialResolved={resolved} />
      </NextIntlClientProvider>,
    );
  });
}

function buttonByText(text: string) {
  return [...container.querySelectorAll("button")].find((b) => b.textContent === text);
}

describe("ReportsAdmin timestamps", () => {
  // lib/dates.test.ts pins the formatting; these pin the wiring, which is the
  // half that regresses when someone edits a table. Until #55 every timestamp
  // here was a fixture input that no assertion ever read, so reverting a call
  // site to toLocaleString left the whole suite green — the way the hydration
  // bug in #38 reached production.

  it("shows the report time in UTC, not the runtime's zone", () => {
    mount();

    expect(container.textContent).toContain("Aug 7, 2026, 2:30:00 AM UTC");
    // What the same instant renders as unpinned in this suite's zone.
    expect(container.textContent).not.toContain("Aug 6");
  });

  it("shows the resolution time in UTC in the audit list", () => {
    mount([], [{ ...OPEN, status: "DISMISSED", resolvedAt: "2026-08-08T02:45:00.000Z" }]);

    expect(container.textContent).toContain("Aug 8, 2026, 2:45:00 AM UTC");
    expect(container.textContent).not.toContain("Aug 7, 2026, 10:45");
  });

  it("formats the timestamp in the locale being browsed", () => {
    // #53 threaded useLocale() in; nothing proved it reached the formatter, so
    // a component that hard-coded a locale looked identical under `en`.
    mount([OPEN], [], "de");

    expect(container.textContent).toContain("07.08.2026, 02:30:00 UTC");
  });
});

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
    const alertMock = vi.fn();
    vi.stubGlobal("alert", alertMock);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ ok: true, ownerNotified: true }), { status: 200 }),
        ),
    );
    const second: ReportRow = { ...OPEN, id: "r2", reporterEmail: null };
    mount([OPEN, second]);
    await act(async () => buttonByText(messages.admin.takedown)!.click());

    expect(fetch).toHaveBeenCalledWith(
      "/api/admin/puzzles/pz1",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(alertMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain(messages.admin.reportsEmpty);
    // Both open reports of the same puzzle moved to resolved.
    expect(container.textContent.match(new RegExp(messages.admin.decisionTakedown, "g"))).toHaveLength(2);
  });

  it("warns when the takedown succeeded but the owner notification failed", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    const alertMock = vi.fn();
    vi.stubGlobal("alert", alertMock);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ ok: true, ownerNotified: false }), { status: 200 }),
        ),
    );
    mount();
    await act(async () => buttonByText(messages.admin.takedown)!.click());

    expect(alertMock).toHaveBeenCalledWith(messages.admin.ownerNotifyFailed);
    // The takedown itself succeeded — the report still moves to resolved.
    expect(container.textContent).toContain(messages.admin.decisionTakedown);
  });

  it("warns when the takedown response cannot be read — unknown must not pass as notified", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    const alertMock = vi.fn();
    vi.stubGlobal("alert", alertMock);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("not json", { status: 200 })),
    );
    mount();
    await act(async () => buttonByText(messages.admin.takedown)!.click());

    expect(alertMock).toHaveBeenCalledWith(messages.admin.ownerNotifyFailed);
  });

  it("keeps a report open and shows the server error when the takedown is rejected", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    const alertMock = vi.fn();
    vi.stubGlobal("alert", alertMock);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: "Storage unreachable" }), { status: 502 }),
        ),
    );
    mount();
    await act(async () => buttonByText(messages.admin.takedown)!.click());

    expect(alertMock).toHaveBeenCalledWith("Storage unreachable");
    // Resolving locally here would drop an unresolved report out of the queue:
    // the admin believes it is handled while it stays OPEN in the database.
    expect(container.textContent).not.toContain(messages.admin.decisionTakedown);
    expect(buttonByText(messages.admin.takedown)).toBeDefined();
  });

  it("keeps a report open when the takedown request never reaches the server", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    const alertMock = vi.fn();
    vi.stubGlobal("alert", alertMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    mount();
    await act(async () => buttonByText(messages.admin.takedown)!.click());

    expect(alertMock).toHaveBeenCalledWith(messages.admin.takedownFailed);
    expect(container.textContent).not.toContain(messages.admin.decisionTakedown);
  });

  it("keeps a report open and shows the server error when the dismiss is rejected", async () => {
    const alertMock = vi.fn();
    vi.stubGlobal("alert", alertMock);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ error: "Report not found" }), { status: 404 })),
    );
    mount();
    await act(async () => buttonByText(messages.admin.dismiss)!.click());

    expect(alertMock).toHaveBeenCalledWith("Report not found");
    expect(container.textContent).not.toContain(messages.admin.decisionDismissed);
    expect(buttonByText(messages.admin.dismiss)).toBeDefined();
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

  it("labels a report closed by an account deletion as its own outcome", () => {
    // The audit list used to read "takedown or else dismissed", so this would
    // have appeared as a decision an admin made — about a report nobody saw.
    mount(
      [],
      [
        {
          ...OPEN,
          status: "ACCOUNT_DELETED",
          reporterEmail: null,
          resolvedAt: "2026-08-08T02:45:00.000Z",
          puzzleExists: false,
        },
      ],
    );

    expect(container.textContent).toContain(messages.admin.decisionAccountDeleted);
    expect(container.textContent).not.toContain(messages.admin.decisionDismissed);
    expect(container.textContent).not.toContain(messages.admin.decisionTakedown);
  });
});
