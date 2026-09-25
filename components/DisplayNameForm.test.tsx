import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "@/messages/en.json";
import DisplayNameForm from "./DisplayNameForm";

vi.mock("@/i18n/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

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

function mount(initial: string | null) {
  act(() => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <DisplayNameForm initial={initial} />
      </NextIntlClientProvider>,
    );
  });
}

function type(value: string) {
  const input = container.querySelector("input")!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  act(() => input.dispatchEvent(new Event("input", { bubbles: true })));
}

describe("DisplayNameForm", () => {
  it("says the name is not set yet", () => {
    mount(null);
    expect(container.textContent).toContain(messages.competition.displayNameUnset);
  });

  it("saves the name and shows what the server stored", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ displayName: "New Name" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    mount("Old Name");

    type("  New   Name ");
    await act(async () => container.querySelector("form")!.requestSubmit());

    expect(fetchMock).toHaveBeenCalledWith("/api/account/display-name", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "  New   Name " }),
    });
    expect(container.querySelector("input")!.value).toBe("New Name");
    expect(container.textContent).toContain(messages.competition.displayNameSaved);
  });

  it("shows the API's reason when the name is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: "The display name must be 2 to 30 characters long." }),
      }),
    );
    mount(null);
    type("x");
    await act(async () => container.querySelector("form")!.requestSubmit());
    expect(container.querySelector(".error")!.textContent).toContain("2 to 30");
  });
});
