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

// The row the invite route leaves behind when delivery fails: created, but with
// no password and no verification.
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
        return new Response(JSON.stringify({ error: "Invitation could not be delivered." }), {
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
      "Invitation could not be delivered.",
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/users");
    expect(container.textContent).toContain("invitee@example.com");
  });

  it("reloads the list and clears the field when the invite succeeds", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/invite")) {
        return new Response(JSON.stringify({ ok: true }), { status: 201 });
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

describe("UsersAdmin re-invite action", () => {
  // An account with a password activated successfully; offering to re-invite it
  // would promise something the route answers 409 to.
  const ACTIVE: UserRow = {
    ...ORPHAN,
    id: "user-2",
    email: "active@example.com",
    verified: true,
    hasPassword: true,
  };

  it("offers the action only on a row that never activated", () => {
    mount([ORPHAN, ACTIVE]);

    const buttons = buttonsLabelled("Invite again");
    expect(buttons).toHaveLength(1);
    expect(buttons[0].closest("tr")!.textContent).toContain("invitee@example.com");
  });

  it("invites the row's own address without the admin retyping it", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/invite")) {
        return new Response(JSON.stringify({ ok: true, reinvited: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ users: [ORPHAN] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
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
  });

  it("reports a failure rather than claiming the mail went out", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/invite")) {
        return new Response(JSON.stringify({ error: "The invitation could not be delivered." }), {
          status: 500,
        });
      }
      return new Response(JSON.stringify({ users: [ORPHAN] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    mount([ORPHAN]);

    await click(buttonsLabelled("Invite again")[0]);

    expect(container.querySelector(".error")?.textContent).toBe(
      "The invitation could not be delivered.",
    );
    expect(container.textContent).not.toContain("sent again");
  });
});
