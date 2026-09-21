import { afterEach, describe, expect, it, vi } from "vitest";
import { tryFetch } from "./try-fetch";

// Characterisation tests for behaviour lifted out of MyPuzzles and
// ReportsAdmin (#56). Those two components' suites already cover it through
// their own call sites; these pin the contract at the seam now that a third
// component depends on it.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("tryFetch", () => {
  it("passes the response through when the request reaches the server", async () => {
    // Including a failed one: only the request not arriving is this function's
    // business, so a 500 comes back as a 500 for the caller to read.
    const response = new Response(null, { status: 500 });
    vi.stubGlobal("fetch", vi.fn(async () => response));

    await expect(tryFetch("admin", "/api/admin/bans")).resolves.toBe(response);
  });

  it("answers null instead of rejecting when the request never arrives", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    await expect(tryFetch("admin", "/api/admin/bans")).resolves.toBeNull();
  });

  it("logs the failure under the caller's scope", async () => {
    // The prefix is the point of the argument: one grep finds every failed
    // request from a surface.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    await tryFetch("my", "/api/puzzles/p1", { method: "DELETE" });

    expect(String(error.mock.calls[0][0])).toContain("[my]");
    expect(String(error.mock.calls[0][0])).toContain("/api/puzzles/p1");
  });

  it("forwards the request options", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await tryFetch("admin", "/api/admin/bans/b1", { method: "DELETE" });

    expect(fetchMock).toHaveBeenCalledWith("/api/admin/bans/b1", { method: "DELETE" });
  });
});
