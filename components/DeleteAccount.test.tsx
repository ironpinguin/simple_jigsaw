import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "@/messages/en.json";
import DeleteAccount from "./DeleteAccount";

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
        <DeleteAccount />
      </NextIntlClientProvider>,
    );
  });
}

function buttonByText(text: string) {
  return [...container.querySelectorAll("button")].find((b) => b.textContent === text);
}

function openForm() {
  mount();
  act(() => buttonByText("Delete account")!.click());
}

function submitWith(password: string) {
  const input = container.querySelector<HTMLInputElement>("#deleteAccountPassword")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    // React tracks the value on the DOM node itself, so setting it through the
    // prototype setter is what makes the synthetic input event carry it.
    setter.call(input, password);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return act(async () => {
    container.querySelector("form")!.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
}

describe("DeleteAccount", () => {
  it("hides the password field behind an explicit first step", () => {
    // The confirmation is the point: a stray click on one button must not be
    // able to erase the account.
    mount();
    expect(container.querySelector("#deleteAccountPassword")).toBeNull();
    expect(container.textContent).toContain("This cannot be undone.");
  });

  it("sends the password and signs out afterwards", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    openForm();

    await submitWith("secret123");

    expect(fetchMock).toHaveBeenCalledWith("/api/account", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "secret123" }),
    });
    // The JWT outlives the row it points at, so it has to be dropped.
    expect(signOutMock).toHaveBeenCalledWith({ callbackUrl: "/en" });
  });

  it("shows the server's message and stays signed in on a rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ error: "That password is not correct." }),
      }),
    );
    openForm();

    await submitWith("wrong");

    expect(container.textContent).toContain("That password is not correct.");
    expect(signOutMock).not.toHaveBeenCalled();
  });

  it("recovers from a network failure instead of hanging on the busy state", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    openForm();

    await submitWith("secret123");

    expect(container.textContent).toContain("The account could not be deleted.");
    expect(buttonByText("Yes, delete my account for good")).toBeTruthy();
    expect(signOutMock).not.toHaveBeenCalled();
  });

  it("does not sign out when the response body is unreadable but the status is ok", async () => {
    // A 200 is the server's confirmation; a broken body must not undo that.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => { throw new Error("bad json"); } }),
    );
    openForm();

    await submitWith("secret123");

    expect(signOutMock).toHaveBeenCalled();
  });
});
