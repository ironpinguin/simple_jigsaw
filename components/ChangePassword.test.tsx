import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "@/messages/en.json";
import ChangePassword from "./ChangePassword";

const { signOutMock } = vi.hoisted(() => ({ signOutMock: vi.fn() }));
vi.mock("next-auth/react", () => ({ signOut: signOutMock }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  signOutMock.mockResolvedValue(undefined);
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
        <ChangePassword />
      </NextIntlClientProvider>,
    );
  });
}

const nativeValueSetter = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype,
  "value",
)!.set!;

// React tracks the value on the DOM node itself, so setting it through the
// prototype setter (as components/DeleteAccount.test.tsx does) is what makes
// the synthetic input event carry it.
function setValue(input: HTMLInputElement, value: string) {
  nativeValueSetter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function submit(current: string, next: string) {
  const [currentInput, newInput] = Array.from(
    container.querySelectorAll<HTMLInputElement>("input[type=password]"),
  );
  await act(async () => {
    setValue(currentInput, current);
    setValue(newInput, next);
  });
  await act(async () => {
    container.querySelector("form")!.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
}

const text = () => container.textContent ?? "";

describe("ChangePassword", () => {
  it("sends the two passwords to the route", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    mount();
    await submit("oldpassword", "newpassword");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/account/password",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ currentPassword: "oldpassword", newPassword: "newpassword" }),
      }),
    );
  });

  it("signs out to the login notice on success", async () => {
    // The session that made the change predates passwordChangedAt like any
    // other, so this device has to sign in again too.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );

    mount();
    await submit("oldpassword", "newpassword");

    expect(signOutMock).toHaveBeenCalledWith({ callbackUrl: "/en/login?changed=1" });
  });

  it("shows the message the route sends and stays put", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "That password is not correct." }), { status: 401 })),
    );

    mount();
    await submit("wrongpassword", "newpassword");

    expect(text()).toContain("That password is not correct.");
    expect(signOutMock).not.toHaveBeenCalled();
  });

  it("falls back to its own message when the refusal carries no body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", { status: 500 })));

    mount();
    await submit("oldpassword", "newpassword");

    expect(text()).toContain(messages.my.changePasswordFailed);
  });

  it("reports a failed request without claiming the password changed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));

    mount();
    await submit("oldpassword", "newpassword");

    expect(text()).toContain(messages.my.changePasswordFailed);
    expect(signOutMock).not.toHaveBeenCalled();
  });
});
