import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "@/messages/en.json";
import UsersAdmin, { type UserRow } from "./UsersAdmin";

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

// A row that never activated: created, but with no password and no
// verification. The invite mail failed, the link expired, or the invitee has
// simply not clicked yet.
const ORPHAN: UserRow = {
  id: "user-1",
  email: "invitee@example.com",
  name: null,
  role: "USER",
  verified: false,
  hasPassword: false,
  createdAt: "2026-08-07T10:00:00.000Z",
};

function mount(initial: UserRow[] = []) {
  act(() => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <UsersAdmin initial={initial} currentUserId="admin-1" />
      </NextIntlClientProvider>,
    );
  });
}

// The email input is controlled, so React only sees a change dispatched through
// the native value setter.
function typeInvite(email: string) {
  const input = container.querySelector<HTMLInputElement>("#inviteEmail")!;
  const setValue = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setValue.call(input, email);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submitInvite() {
  const form = container.querySelector("form")!;
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

function buttonsLabelled(label: string) {
  return [...container.querySelectorAll("button")].filter((b) => b.textContent === label);
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("UsersAdmin invite form", () => {
  it("reloads the list when the invite fails, so the stranded row is visible", async () => {
    // The route creates the row before it sends, so a 500 still leaves an
    // account behind — the admin needs it on screen to invite it again.
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/invite")) {
        return new Response(JSON.stringify({ error: "The invitation could not be sent." }), {
          status: 500,
        });
      }
      return new Response(JSON.stringify({ users: [ORPHAN] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    mount();
    expect(container.textContent).not.toContain("invitee@example.com");

    typeInvite("invitee@example.com");
    await submitInvite();

    expect(container.querySelector(".error")?.textContent).toBe(
      "The invitation could not be sent.",
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/users");
    expect(container.textContent).toContain("invitee@example.com");
  });

  it("reloads the list and clears the field when the invite succeeds", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/invite")) {
        return new Response(JSON.stringify({ ok: true, reinvited: false }), { status: 201 });
      }
      return new Response(JSON.stringify({ users: [ORPHAN] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    mount();
    typeInvite("invitee@example.com");
    await submitInvite();

    expect(container.querySelector(".error")).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/users");
    expect(container.querySelector<HTMLInputElement>("#inviteEmail")!.value).toBe("");
    // The other half of the pair below: a first invitation must not announce
    // itself as a re-invite, which would tell the admin the address was already
    // in the system.
    expect(container.textContent).toContain("Invitation sent to invitee@example.com.");
    expect(container.textContent).not.toContain("sent again");
  });

  it("says the invitation was re-sent when the address was already invited", async () => {
    // Typing an already-invited address into the form re-invites rather than
    // failing, so the flash must not claim a first invitation went out.
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/invite")) {
        return new Response(JSON.stringify({ ok: true, reinvited: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ users: [ORPHAN] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    mount();
    typeInvite("invitee@example.com");
    await submitInvite();

    expect(container.textContent).toContain("Invitation to invitee@example.com sent again.");
    expect(container.textContent).not.toContain("Invitation sent to invitee@example.com.");
  });
});

describe("UsersAdmin list reload", () => {
  const STALE = "The list could not be reloaded and may be out of date.";

  // Every action reloads the table afterwards, and the table is what the admin
  // acts on next: the invite error tells them to invite the same address again,
  // which needs the row on screen. A reload that fails quietly leaves them
  // working from a list that no longer matches the database.
  function stubReload(reload: () => Response | never) {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).endsWith("/invite")
        ? new Response(JSON.stringify({ ok: true, reinvited: false }), { status: 201 })
        : reload(),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("says the list may be stale without disowning the action that succeeded", async () => {
    // Two different facts: the invitation really did go out, and the table is now
    // out of date. Neither message may overwrite the other.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    stubReload(() => new Response("upstream error", { status: 500 }));
    mount([ORPHAN]);

    typeInvite("second@example.com");
    await submitInvite();

    expect(container.textContent).toContain("Invitation sent to second@example.com.");
    expect(container.textContent).toContain(STALE);
    expect(container.textContent).toContain("invitee@example.com");
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("keeps the page up when the reload returns an unexpected body", async () => {
    // A 200 carrying anything but a users array used to put `undefined` into
    // state, and the render then threw on `.map` — the whole admin page blank
    // over what is only a stale table.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    stubReload(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    mount([ORPHAN]);

    typeInvite("second@example.com");
    await submitInvite();

    expect(container.querySelector("table")).not.toBeNull();
    expect(container.textContent).toContain("invitee@example.com");
    expect(container.textContent).toContain(STALE);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("says so when the reload request never lands", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    stubReload(() => {
      throw new TypeError("Failed to fetch");
    });
    mount([ORPHAN]);

    typeInvite("second@example.com");
    await submitInvite();

    expect(container.textContent).toContain(STALE);
    expect(container.textContent).toContain("invitee@example.com");
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("takes the notice back down once a reload works", async () => {
    let failing = true;
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/invite")) {
        return new Response(JSON.stringify({ ok: true, reinvited: false }), { status: 201 });
      }
      if (failing) {
        failing = false;
        return new Response("upstream error", { status: 500 });
      }
      return new Response(JSON.stringify({ users: [ORPHAN] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    mount([]);

    typeInvite("second@example.com");
    await submitInvite();
    expect(container.textContent).toContain(STALE);

    typeInvite("third@example.com");
    await submitInvite();

    expect(container.textContent).not.toContain(STALE);
    expect(container.textContent).toContain("invitee@example.com");
    logged.mockRestore();
  });
});

describe("UsersAdmin re-invite action", () => {
  // A row with a password can be logged into, so the route refuses to re-invite
  // it and offering the action would promise something that cannot happen.
  const ACTIVE: UserRow = {
    ...ORPHAN,
    id: "user-2",
    email: "active@example.com",
    verified: true,
    hasPassword: true,
  };

  // The row that separates the two conditions: self-registered, so it has a
  // password, but the confirmation mail is still outstanding. It shares
  // `verified: false` with ORPHAN and `hasPassword: true` with ACTIVE, so a gate
  // written against the wrong field shows up here and nowhere else.
  const UNVERIFIED: UserRow = {
    ...ORPHAN,
    id: "user-3",
    email: "unverified@example.com",
    verified: false,
    hasPassword: true,
  };

  // The action revokes a link that may still be valid, so it confirms first.
  beforeEach(() => {
    vi.stubGlobal("confirm", vi.fn(() => true));
  });

  function stubInviteFetch(response: () => Response) {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).endsWith("/invite")
        ? response()
        : new Response(JSON.stringify({ users: [ORPHAN] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("offers the action only on a row that never activated", () => {
    mount([ORPHAN, ACTIVE, UNVERIFIED]);

    const buttons = buttonsLabelled("Invite again");
    expect(buttons).toHaveLength(1);
    expect(buttons[0].closest("tr")!.textContent).toContain("invitee@example.com");
  });

  it("invites the row's own address without the admin retyping it", async () => {
    const fetchMock = stubInviteFetch(
      () => new Response(JSON.stringify({ ok: true, reinvited: true }), { status: 200 }),
    );
    mount([ORPHAN]);

    await click(buttonsLabelled("Invite again")[0]);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/users/invite",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ email: "invitee@example.com" }),
      }),
    );
    expect(container.querySelector(".error")).toBeNull();
    expect(container.textContent).toContain("Invitation to invitee@example.com sent again.");
    // Says the earlier link died, or the admin has no reason to connect this
    // click to the invitee reporting a dead link afterwards.
    expect(container.textContent).toContain("The earlier link no longer works.");
    // The row may have been activated or deleted since the page loaded.
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/users");
  });

  it("does nothing when the admin cancels the confirmation", async () => {
    // Revoking a live link on a misclick has no undo.
    const fetchMock = stubInviteFetch(
      () => new Response(JSON.stringify({ ok: true, reinvited: true }), { status: 200 }),
    );
    vi.stubGlobal("confirm", vi.fn(() => false));
    mount([ORPHAN]);

    await click(buttonsLabelled("Invite again")[0]);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("sent again");
  });

  it("disables the action while a request is in flight", async () => {
    // Two clicks send two mails, and the second revokes the first token — so the
    // invitee ends up holding two invitations of which the older one is silently
    // dead, the exact confusion this feature exists to end.
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/invite")) {
        await pending;
        return new Response(JSON.stringify({ ok: true, reinvited: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ users: [ORPHAN] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    mount([ORPHAN]);

    await click(buttonsLabelled("Invite again")[0]);
    expect(buttonsLabelled("Invite again")[0].disabled).toBe(true);

    await act(async () => {
      release();
      await pending;
    });
    expect(buttonsLabelled("Invite again")[0].disabled).toBe(false);
  });

  it("reports a failure rather than claiming the mail went out", async () => {
    stubInviteFetch(
      () =>
        new Response(JSON.stringify({ error: "The invitation could not be sent." }), {
          status: 500,
        }),
    );
    mount([ORPHAN]);

    await click(buttonsLabelled("Invite again")[0]);

    expect(container.querySelector(".error")?.textContent).toBe(
      "The invitation could not be sent.",
    );
    expect(container.textContent).not.toContain("sent again");
  });

  it("reports a rejected request instead of leaving the button dead", async () => {
    // No response means neither branch runs. Without the try/finally `busy` would
    // stay true and every button on the page would be stuck, with nothing said.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/invite")) throw new TypeError("Failed to fetch");
        return new Response(JSON.stringify({ users: [ORPHAN] }), { status: 200 });
      }),
    );
    mount([ORPHAN]);

    await click(buttonsLabelled("Invite again")[0]);

    expect(container.querySelector(".error")?.textContent).toBe("Invitation failed.");
    expect(buttonsLabelled("Invite again")[0].disabled).toBe(false);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
