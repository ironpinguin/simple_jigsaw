import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { replaceMock } = vi.hoisted(() => ({ replaceMock: vi.fn() }));

vi.mock("next-intl", () => ({ useLocale: () => "de" }));
vi.mock("@/i18n/navigation", () => ({
  usePathname: () => "/my",
  useRouter: () => ({ replace: replaceMock }),
}));

import LanguageSwitcher from "./LanguageSwitcher";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function mount(props: { persist?: boolean } = {}) {
  act(() => {
    root.render(<LanguageSwitcher {...props} />);
  });
}

function click(label: string) {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!button) throw new Error(`no ${label} button`);
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("LanguageSwitcher", () => {
  it("switches the page language", async () => {
    mount();

    click("EN");

    expect(replaceMock).toHaveBeenCalledWith("/my", { locale: "en" });
  });

  it("remembers the choice on the account when someone is signed in", async () => {
    // Picking a language in the header is the statement "this is my language",
    // so it is also what decides the language of mail sent to this user by
    // somebody else — an admin notification, a takedown notice. There is no
    // second setting to keep in step with this one.
    mount({ persist: true });

    click("IT");
    await act(async () => {});

    expect(fetch).toHaveBeenCalledWith(
      "/api/account/locale",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ locale: "it" }) }),
    );
  });

  it("does not call the account route for a signed-out visitor", async () => {
    // There is no row to write, and the route would only answer 401.
    mount();

    click("IT");
    await act(async () => {});

    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not write anything when the locale did not change", async () => {
    mount({ persist: true });

    click("DE");
    await act(async () => {});

    expect(replaceMock).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("says so when the account route refuses the write", async () => {
    // A tab left open until the session cookie expired: the PUT answers 401,
    // the page still switches, and without this the user's mail language stays
    // what it was with nothing anywhere recording that it did not change.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));

    mount({ persist: true });
    click("EN");
    await act(async () => {});

    expect(logged).toHaveBeenCalledWith(expect.stringContaining("401"));
    expect(replaceMock).toHaveBeenCalledWith("/my", { locale: "en" });
    logged.mockRestore();
  });

  it("still switches the page when storing the choice fails", async () => {
    // The language the visitor asked for is the point; persisting it is a side
    // effect they never asked about, and an unreachable route must neither
    // strand them on the old locale nor surface an unhandled rejection.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    mount({ persist: true });
    click("EN");
    await act(async () => {});

    expect(replaceMock).toHaveBeenCalledWith("/my", { locale: "en" });
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
