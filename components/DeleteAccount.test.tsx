import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "@/messages/en.json";
import itMessages from "@/messages/it.json";
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

function mountWith(locale: "en" | "it") {
  act(() => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === "it" ? itMessages : messages}>
        <DeleteAccount />
      </NextIntlClientProvider>,
    );
  });
}

function mount() {
  mountWith("en");
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

  it("falls back to a generic message when the error body is unreadable", async () => {
    // A proxy answering 502 with an HTML page leaves `error` undefined; the
    // form must not un-busy with no explanation at all.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: async () => {
          throw new Error("bad json");
        },
      }),
    );
    openForm();

    await submitWith("secret123");

    expect(container.textContent).toContain("The account could not be deleted.");
    expect(signOutMock).not.toHaveBeenCalled();
  });

  it("disables the submit button while the request is in flight", async () => {
    // submit() has no re-entrancy guard, so the disabled state is the only
    // thing stopping a second DELETE whose 404 would paint an error over a
    // deletion that actually succeeded.
    let release: (v: unknown) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValue(new Promise((resolve) => (release = resolve))),
    );
    openForm();

    await submitWith("secret123");
    expect(buttonByText("Deleting account…")?.hasAttribute("disabled")).toBe(true);
    expect(buttonByText("Cancel")?.hasAttribute("disabled")).toBe(true);

    await act(async () => release({ ok: true, json: async () => ({ ok: true }) }));
  });

  it("tells the user the account is gone when signing out fails", async () => {
    // The server already confirmed the deletion. Leaving the form spinning
    // with no message would strand the user looking signed in.
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }));
    signOutMock.mockRejectedValue(new Error("offline"));
    openForm();

    await submitWith("secret123");

    expect(container.textContent).toContain("Your account was deleted, but signing out failed.");
    expect(buttonByText("Yes, delete my account for good")).toBeTruthy();
  });

  it("returns an Italian user to the Italian home page", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }));
    mountWith("it");
    act(() => buttonByText("Elimina account")!.click());

    await submitWith("secret123");

    expect(signOutMock).toHaveBeenCalledWith({ callbackUrl: "/it" });
  });
});
