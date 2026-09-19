import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "@/messages/en.json";
import ResetPage from "./page";

const { searchParams } = vi.hoisted(() => ({ searchParams: { value: new URLSearchParams() } }));

vi.mock("next/navigation", () => ({ useSearchParams: () => searchParams.value }));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
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
        <ResetPage />
      </NextIntlClientProvider>,
    );
  });
}

/** React's controlled-input tracker absorbs a plain `.value =` assignment. */
function setValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function submit(password: string) {
  const input = container.querySelector<HTMLInputElement>("input[type=password]")!;
  await act(async () => setValue(input, password));
  await act(async () => {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

const text = () => container.textContent ?? "";

describe("ResetPage", () => {
  it("says the link carried no token, without asking the server", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    mount();

    expect(text()).toContain(messages.auth.verifyNoToken);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the token and password, then shows success", async () => {
    searchParams.value = new URLSearchParams({ token: "good-token" });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    mount();
    await submit("new-password");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/account/password/reset",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ token: "good-token", password: "new-password" }),
      }),
    );
    expect(text()).toContain(messages.auth.resetDone);
  });

  it("shows the failure message on a refusal", async () => {
    searchParams.value = new URLSearchParams({ token: "stale" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "Link expired" }), { status: 400 })),
    );

    mount();
    await submit("new-password");

    expect(text()).toContain("Link expired");
  });

  it("falls back to its own message when the refusal carries no body", async () => {
    searchParams.value = new URLSearchParams({ token: "stale" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 500 })),
    );

    mount();
    await submit("new-password");

    expect(text()).toContain(messages.auth.resetFailed);
  });
});
