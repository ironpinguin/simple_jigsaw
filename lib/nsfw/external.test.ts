import { afterEach, describe, expect, it, vi } from "vitest";
import { createExternalClassifier } from "./external";

const config = {
  mode: "external" as const,
  threshold: 0.85,
  timeoutMs: 5000,
  apiUrl: "https://classifier.example/check",
  apiKey: "secret",
};

afterEach(() => vi.unstubAllGlobals());

function respondWith(init: { ok: boolean; status?: number; body?: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: init.ok,
      status: init.status ?? (init.ok ? 200 : 500),
      json: async () => init.body,
    })),
  );
}

describe("createExternalClassifier", () => {
  it("turns the service's score into a verdict", async () => {
    respondWith({ ok: true, body: { score: 0.91 } });

    const verdict = await createExternalClassifier(config).classify(Buffer.from("x"));

    expect(verdict.label).toBe("FLAGGED");
    expect(verdict.score).toBe(0.91);
  });

  it("sends the key and the bytes to the configured url", async () => {
    respondWith({ ok: true, body: { score: 0.1 } });

    const imageBytes = Buffer.from([0x52, 0x49, 0x46, 0x46]); // "RIFF" header, recognizable
    await createExternalClassifier(config).classify(imageBytes);

    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://classifier.example/check");
    expect(init.headers.Authorization).toBe("Bearer secret");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("image/webp");
    expect(new Uint8Array(init.body)).toEqual(new Uint8Array(imageBytes));
  });

  it("throws on a refusal, so the guard can hold the image", async () => {
    // Not a silent CLEAN: a service that is down must not publish everything.
    respondWith({ ok: false, status: 503 });

    await expect(
      createExternalClassifier(config).classify(Buffer.from("x")),
    ).rejects.toThrow();
  });

  it("throws on a response without a usable score", async () => {
    respondWith({ ok: true, body: { verdict: "probably fine" } });

    await expect(
      createExternalClassifier(config).classify(Buffer.from("x")),
    ).rejects.toThrow();
  });
});
