import { describe, expect, it, vi } from "vitest";
import { guard } from "./guard";
import type { Classifier } from "./types";

const bytes = Buffer.from("not really an image");

describe("guard", () => {
  it("passes a verdict straight through", async () => {
    const inner: Classifier = {
      classify: async () => ({ label: "CLEAN", score: 0.1, model: "fake" }),
    };

    await expect(guard(inner, 50).classify(bytes)).resolves.toEqual({
      label: "CLEAN",
      score: 0.1,
      model: "fake",
    });
  });

  it("turns a throw into UNKNOWN and logs it", async () => {
    // Nothing may pass unexamined: an exception that read as CLEAN would make
    // a broken classifier look exactly like a clean instance.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const inner: Classifier = {
      classify: async () => {
        throw new Error("model not loaded");
      },
    };

    const verdict = await guard(inner, 50).classify(bytes);

    expect(verdict.label).toBe("UNKNOWN");
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("gives up at the timeout instead of holding the upload open", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const inner: Classifier = {
      classify: () => new Promise(() => {}), // never settles
    };

    const verdict = await guard(inner, 20).classify(bytes);

    expect(verdict.label).toBe("UNKNOWN");
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
