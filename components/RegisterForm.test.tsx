import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "@/messages/en.json";
import RegisterForm from "./RegisterForm";

// next-intl's Link pulls in next/navigation, which vitest cannot resolve from
// this package's ESM build; the form under test only needs an anchor.
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
        <RegisterForm />
      </NextIntlClientProvider>,
    );
  });
}

/** Drive a controlled input the way a keystroke would. */
function type(selector: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(selector)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/**
 * Submit past HTML validation, the way a devtools user or a stale client
 * could — the server contract must not depend on the `required` attributes.
 */
async function submit() {
  const form = container.querySelector("form")!;
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

function fillValidForm() {
  type("#email", "erika@example.com");
  type("#password", "long-enough-pw");
  act(() => container.querySelector<HTMLInputElement>("#terms")!.click());
}

const submitButton = () => container.querySelector<HTMLButtonElement>("button[type=submit]")!;
const errorText = () => container.querySelector(".error")?.textContent ?? null;

describe("the registration payload", () => {
  it("sends termsAccepted: true once the checkbox is ticked", async () => {
    // The field name is the contract with RegisterSchema on the server; a
    // rename on either side breaks registration for every user.
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    mount();
    fillValidForm();
    await submit();
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ email: "erika@example.com", termsAccepted: true });
  });

  it("marks the terms checkbox required, so the browser blocks unchecked submits", () => {
    mount();
    expect(container.querySelector<HTMLInputElement>("#terms")!.required).toBe(true);
  });
});

describe("submit failure handling", () => {
  it("shows the server's error message on a rejected registration", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: "Server says no." }),
    });
    vi.stubGlobal("fetch", fetchMock);
    mount();
    fillValidForm();
    await submit();
    expect(errorText()).toBe("Server says no.");
    expect(submitButton().disabled).toBe(false);
  });

  it("recovers from a network failure with a translated error, not a stuck spinner", async () => {
    // fetch *rejects* (offline, DNS, dropped connection) instead of returning
    // a response; the form must re-enable and say something.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    mount();
    fillValidForm();
    await submit();
    expect(errorText()).toBe(messages.auth.registerFailed);
    expect(submitButton().disabled).toBe(false);
    expect(submitButton().textContent).toBe(messages.auth.registerSubmit);
  });
});
