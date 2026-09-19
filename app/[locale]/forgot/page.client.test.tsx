import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "@/messages/en.json";
import ForgotPage from "./page";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
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

function mount() {
  act(() => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ForgotPage />
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

async function submit(email: string) {
  const input = container.querySelector<HTMLInputElement>("input[type=email]")!;
  await act(async () => setValue(input, email));
  await act(async () => {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

const text = () => container.textContent ?? "";

describe("ForgotPage", () => {
  it("posts the address to the request endpoint", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    mount();
    await submit("someone@example.com");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/account/password/reset-request",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ email: "someone@example.com" }) }),
    );
  });

  it("shows the same confirmation whatever the address was", async () => {
    // The page must not reveal more than the endpoint does.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));

    mount();
    await submit("nobody@example.com");

    expect(text()).toContain(messages.auth.forgotDone);
  });

  it("reports a failed request without claiming a link was sent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));

    mount();
    await submit("someone@example.com");

    expect(text()).toContain(messages.auth.forgotFailed);
    expect(text()).not.toContain(messages.auth.forgotDone);
  });

  it("shows the failure message on a non-2xx, without inspecting the body", async () => {
    // Every return path in the route answers 200; a non-2xx can only come
    // from infrastructure (a proxy 502, a framework 500), never from
    // anything about the account, so branching on status leaks nothing.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 502 })));

    mount();
    await submit("someone@example.com");

    expect(text()).toContain(messages.auth.forgotFailed);
    expect(text()).not.toContain(messages.auth.forgotDone);
  });
});
