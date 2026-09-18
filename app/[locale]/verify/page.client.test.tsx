import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "@/messages/en.json";
import VerifyPage from "./page";

const { searchParams } = vi.hoisted(() => ({ searchParams: { value: new URLSearchParams() } }));

vi.mock("next/navigation", () => ({ useSearchParams: () => searchParams.value }));
// next-intl's Link reaches for the router; this page only ever renders one.
vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  searchParams.value = new URLSearchParams();
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
        <VerifyPage />
      </NextIntlClientProvider>,
    );
  });
}

const text = () => container.textContent ?? "";

describe("VerifyPage", () => {
  it("says the link carried no token, without asking the server", async () => {
    // No token means there is nothing to verify: the failure is knowable from
    // the URL alone, so it must not cost a request.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    mount();
    // On the very first paint, before any effect has run: the error is derived
    // from the URL, so there is no "checking…" to flash past. Setting it in an
    // effect instead showed pending and then corrected itself (#84).
    expect(text()).toContain(messages.auth.verifyNoToken);
    expect(text()).not.toContain(messages.auth.verifyPending);

    await act(async () => {});

    expect(text()).toContain(messages.auth.verifyNoToken);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports success once the server accepts the token", async () => {
    searchParams.value = new URLSearchParams({ token: "good-token" });
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    mount();
    await act(async () => {});

    expect(text()).toContain(messages.auth.verifyOk);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/verify",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ token: "good-token" }) }),
    );
  });

  it("shows the server's own message when it refuses", async () => {
    // The route translates its errors; echoing its message is the whole point
    // of not inventing one here.
    searchParams.value = new URLSearchParams({ token: "stale" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "Link expired" }), { status: 400 })),
    );

    mount();
    await act(async () => {});

    expect(text()).toContain("Link expired");
  });

  it("falls back to its own message when the refusal carries no body", async () => {
    searchParams.value = new URLSearchParams({ token: "stale" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 500 })),
    );

    mount();
    await act(async () => {});

    expect(text()).toContain(messages.auth.inviteFailed);
  });

  it("shows the pending message until the request settles", async () => {
    searchParams.value = new URLSearchParams({ token: "slow" });
    let release: (r: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => (release = resolve))),
    );

    mount();
    expect(text()).toContain(messages.auth.verifyPending);

    await act(async () => {
      release(new Response("{}", { status: 200 }));
    });
    expect(text()).toContain(messages.auth.verifyOk);
  });
});
