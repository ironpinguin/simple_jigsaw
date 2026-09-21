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
  // See the components project in vitest.config.ts: 02:30 UTC is the previous
  // day in the suite's zone, so a call site formatting in the runtime's zone
  // renders "Aug 6" and the date assertion below fails (#55).
  createdAt: "2026-08-07T02:30:00.000Z",
};

function mount(initial = [] as (typeof BAN)[], locale = "en") {
  act(() => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={messages}>
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

describe("BansAdmin rendering", () => {
  it("shows the value, the type and the date the ban was added in UTC", () => {
    // This component had no test file at all until #56, and nothing proved it
    // called the shared formatter rather than formatting in the runtime's zone.
    mount([BAN]);

    expect(container.textContent).toContain("spam.example");
    expect(container.textContent).toContain(messages.admin.banTypeDomain);
    expect(container.textContent).toContain("Aug 7, 2026");
    expect(container.textContent).not.toContain("Aug 6, 2026");
  });

  it("formats the date in the locale being browsed", () => {
    // Pinning the zone proves the formatter is called; this proves the locale
    // reaches it. A hard-coded "en" is invisible under `en`.
    mount([BAN], "de");

    expect(container.textContent).toContain("07.08.2026");
  });
});

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

  it("keeps warning that the list is behind after a later add succeeds", async () => {
    // The first add's row never made it into the table, and adding a different
    // ban does nothing to put it there. Clearing the warning on the next action
    // would hand the admin a table they have no reason to distrust and one row
    // short — UsersAdmin only clears its own `stale` once a reload succeeded.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ unexpected: true }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ban: BAN }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    mount();
    typeValue("lost.example");
    await submit();
    expect(container.textContent).toContain(messages.admin.listStale);

    typeValue("spam.example");
    await submit();

    expect(container.textContent).toContain("spam.example");
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

    expect(container.querySelector(".error")?.textContent).toContain("spam.example");
    expect(container.textContent).toContain("spam.example");
  });

  it("names the row it could not remove", async () => {
    // One page-level message for a table of rows: "Removing failed." leaves the
    // admin to guess which click it belongs to, and the next action wipes it.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({}), { status: 403 })),
    );

    mount([BAN, { ...BAN, id: "ban-2", value: "other.example" }]);
    const second = [...container.querySelectorAll("button")].filter(
      (b) => b.textContent === messages.admin.banRemove,
    )[1] as HTMLButtonElement;
    await act(async () => {
      second.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.querySelector(".error")?.textContent).toContain("other.example");
    expect(container.querySelector(".error")?.textContent).not.toContain("spam.example");
  });

  it("disables only the row being removed while the request is in flight", async () => {
    // Otherwise a slow connection gives no sign the click registered — the same
    // ambiguity this card is about, on the latency side instead of the error
    // side — and the row can be submitted twice.
    let release!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => pending),
    );

    mount([BAN, { ...BAN, id: "ban-2", value: "other.example" }]);
    const [first, second] = [...container.querySelectorAll("button")].filter(
      (b) => b.textContent === messages.admin.banRemove,
    ) as HTMLButtonElement[];
    act(() => {
      first.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(first.disabled).toBe(true);
    expect(second.disabled).toBe(false);

    await act(async () => {
      release(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      await pending;
    });

    expect(container.textContent).not.toContain("spam.example");
  });

  it("keeps each overlapping removal disabled until its own request answers", async () => {
    // A single in-flight slot is wrong the moment two removals overlap: the
    // first response clears it, so the second row's button re-enables while its
    // DELETE is still out and a second click sends a duplicate.
    const answers: ((value: Response) => void)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            answers.push(resolve);
          }),
      ),
    );

    mount([BAN, { ...BAN, id: "ban-2", value: "other.example" }]);
    const [first, second] = [...container.querySelectorAll("button")].filter(
      (b) => b.textContent === messages.admin.banRemove,
    ) as HTMLButtonElement[];

    act(() => {
      first.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    act(() => {
      second.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(first.disabled).toBe(true);
    expect(second.disabled).toBe(true);

    // The first row answers; the second is still waiting and must stay locked.
    await act(async () => {
      answers[0](new Response(JSON.stringify({ ok: true }), { status: 200 }));
      await Promise.resolve();
    });

    const stillThere = [...container.querySelectorAll("button")].filter(
      (b) => b.textContent === messages.admin.banRemove,
    ) as HTMLButtonElement[];
    expect(stillThere).toHaveLength(1);
    expect(stillThere[0].disabled).toBe(true);
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

    expect(container.querySelector(".error")?.textContent).toContain("spam.example");
    expect(container.querySelectorAll("tbody tr").length).toBe(1);
  });

  it("drops the row when the server accepts", async () => {
    // What the route actually answers (app/api/admin/bans/[id]/route.ts).
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );

    mount([BAN]);
    await clickRemove();

    expect(container.textContent).not.toContain("spam.example");
    expect(container.textContent).toContain(messages.admin.banNone);
  });
});
