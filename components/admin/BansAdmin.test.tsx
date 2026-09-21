import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "@/messages/en.json";
import BansAdmin from "./BansAdmin";

// The three ways this list used to fail without telling anyone (#56): a failed
// add left the submit button disabled for good, a failed remove said nothing at
// all, and a 201 carrying an unexpected body put `undefined` into the table and
// blanked the page on the next render.

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
  vi.restoreAllMocks();
});

const BAN = {
  id: "ban-1",
  value: "spam.example",
  type: "DOMAIN",
  createdAt: "2026-08-07T10:00:00.000Z",
};

function mount(initial = [] as (typeof BAN)[]) {
  act(() => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <BansAdmin initial={initial} />
      </NextIntlClientProvider>,
    );
  });
}

// The input is controlled, so React only sees a change dispatched through the
// native value setter.
function typeValue(value: string) {
  const input = container.querySelector<HTMLInputElement>("#banValue")!;
  const setValue = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit() {
  const form = container.querySelector("form")!;
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

async function clickRemove() {
  const button = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === messages.admin.banRemove,
  )!;
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function submitButton() {
  return container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
}

describe("BansAdmin add", () => {
  it("re-enables the form and says so when the request never reaches the server", async () => {
    // Without a catch the rejection is unhandled, `setBusy(false)` never runs,
    // and the admin is left with a permanently disabled button and no reason.
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    mount();
    typeValue("spam.example");
    await submit();

    expect(submitButton().disabled).toBe(false);
    expect(container.querySelector(".error")?.textContent).toBe(messages.admin.banAddFailed);
  });

  it("logs the failed request rather than swallowing it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    mount();
    typeValue("spam.example");
    await submit();

    expect(error).toHaveBeenCalled();
    expect(String(error.mock.calls[0][0])).toContain("[admin]");
  });

  it("keeps a malformed success body out of the table", async () => {
    // A 201 whose body is not the ban pushed `undefined` into the list, and the
    // next render threw on `b.value` — blanking the entire admin page over a
    // row that cannot be displayed.
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ unexpected: true }), { status: 201 })),
    );

    mount();
    typeValue("spam.example");
    await submit();

    // The page still renders, and says the list is behind rather than claiming
    // the add failed — the server did create the ban.
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.textContent).toContain(messages.admin.listStale);
  });

  it("adds the returned ban to the table on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ban: BAN }), { status: 201 })),
    );

    mount();
    typeValue("spam.example");
    await submit();

    expect(container.textContent).toContain("spam.example");
    expect(submitButton().disabled).toBe(false);
  });
});

describe("BansAdmin remove", () => {
  it("says so when the server refuses, instead of leaving the row unexplained", async () => {
    // `if (res.ok)` with no else: the admin clicked Remove, the row stayed, and
    // nothing on the page or in the log said why.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({}), { status: 403 })),
    );

    mount([BAN]);
    await clickRemove();

    expect(container.querySelector(".error")?.textContent).toBe(messages.admin.banRemoveFailed);
    expect(container.textContent).toContain("spam.example");
  });

  it("prefers the reason the server gave", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "Not your ban." }), { status: 403 })),
    );

    mount([BAN]);
    await clickRemove();

    expect(container.querySelector(".error")?.textContent).toBe("Not your ban.");
  });

  it("says so when the request never reaches the server", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    mount([BAN]);
    await clickRemove();

    expect(container.querySelector(".error")?.textContent).toBe(messages.admin.banRemoveFailed);
    expect(container.textContent).toContain("spam.example");
  });

  it("drops the row when the server accepts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );

    mount([BAN]);
    await clickRemove();

    expect(container.textContent).not.toContain("spam.example");
    expect(container.textContent).toContain(messages.admin.banNone);
  });
});
