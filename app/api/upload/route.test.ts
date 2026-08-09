import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

const { getSessionUserMock, putObjectMock, classifyMock, verdictCreate } = vi.hoisted(() => ({
  getSessionUserMock: vi.fn(),
  putObjectMock: vi.fn(),
  classifyMock: vi.fn(),
  verdictCreate: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getSessionUser: getSessionUserMock }));
vi.mock("@/lib/storage", () => ({ putObject: putObjectMock }));
vi.mock("@/lib/db", () => ({
  prisma: { imageVerdict: { create: verdictCreate } },
}));
// sharp is deliberately NOT mocked: the tests below rely on it genuinely
// re-encoding the upload, so "the bytes judged are the bytes stored" is a real
// property rather than an assumption.
vi.mock("@/lib/nsfw", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/nsfw")>()),
  getClassifier: () => ({ classify: classifyMock }),
}));
vi.mock("@/lib/i18n-server", () => ({ getErrorT: async () => (key: string) => key }));

import { POST } from "./route";

let jpegFixture: Buffer;

beforeAll(async () => {
  // A tiny real JPEG, built with sharp rather than a hand-rolled byte array,
  // so the route's own sharp pipeline has genuine image bytes to re-encode.
  jpegFixture = await sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 200, g: 120, b: 40 } },
  })
    .jpeg()
    .toBuffer();
});

function uploadRequest(bytes: Buffer, options: { type?: string; filename?: string } = {}) {
  const form = new FormData();
  const file = new File([bytes], options.filename ?? "photo.jpg", {
    type: options.type ?? "image/jpeg",
  });
  form.set("file", file);
  return new Request("http://test/api/upload", { method: "POST", body: form });
}

beforeEach(() => {
  vi.clearAllMocks();
  getSessionUserMock.mockResolvedValue({ id: "user-1" });
  putObjectMock.mockResolvedValue(undefined);
  classifyMock.mockResolvedValue({ label: "CLEAN", score: 0.02, model: "fake" });
  verdictCreate.mockResolvedValue({});
});

describe("POST /api/upload", () => {
  it("requires login", async () => {
    getSessionUserMock.mockResolvedValue(null);

    const res = await POST(uploadRequest(jpegFixture));

    expect(res.status).toBe(401);
    expect(putObjectMock).not.toHaveBeenCalled();
  });

  it("rejects a request with no file", async () => {
    const form = new FormData();
    const res = await POST(new Request("http://test/api/upload", { method: "POST", body: form }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "noFile" });
  });

  it("rejects an unsupported file type", async () => {
    const res = await POST(uploadRequest(jpegFixture, { type: "image/gif" }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unsupportedType" });
  });

  it("rejects a file over the size cap", async () => {
    const oversized = Buffer.alloc(15 * 1024 * 1024 + 1);
    const res = await POST(uploadRequest(oversized));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "tooLarge" });
  });

  it("stores the re-encoded image and returns only its key and dimensions", async () => {
    const res = await POST(uploadRequest(jpegFixture));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.imageKey).toMatch(/^puzzles\/.+\.webp$/);
    expect(body.width).toBe(4);
    expect(body.height).toBe(4);
    expect(Object.keys(body).sort()).toEqual(["height", "imageKey", "width"]);
    expect(putObjectMock).toHaveBeenCalledWith(body.imageKey, expect.any(Buffer), "image/webp");
  });
});

describe("classification", () => {
  beforeEach(() => {
    classifyMock.mockResolvedValue({ label: "CLEAN", score: 0.02, model: "fake" });
    verdictCreate.mockResolvedValue({});
  });

  it("judges the re-encoded bytes, not the upload", async () => {
    // The stored WebP is what gets served, so it is what must be judged.
    await POST(uploadRequest(jpegFixture));

    const judged = classifyMock.mock.calls[0][0] as Buffer;
    expect(judged.subarray(8, 12).toString()).toBe("WEBP");
  });

  it("stores the verdict against the key it wrote", async () => {
    const res = await POST(uploadRequest(jpegFixture));
    const { imageKey } = await res.json();

    expect(verdictCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ imageKey, label: "CLEAN", score: 0.02, model: "fake" }),
      }),
    );
  });

  it("classifies before the bytes are written to storage", async () => {
    // Order is deliberate: a putObject failure must leave no verdict behind.
    const order: string[] = [];
    classifyMock.mockImplementation(async () => {
      order.push("classify");
      return { label: "CLEAN", score: 0.02, model: "fake" };
    });
    putObjectMock.mockImplementation(async () => {
      order.push("putObject");
    });

    await POST(uploadRequest(jpegFixture));

    expect(order).toEqual(["classify", "putObject"]);
  });

  it("never tells the client what the verdict was", async () => {
    // A client that learns the score learns the threshold.
    classifyMock.mockResolvedValue({ label: "FLAGGED", score: 0.97, model: "fake" });

    const body = await (await POST(uploadRequest(jpegFixture))).text();

    expect(body).not.toContain("FLAGGED");
    expect(body).not.toContain("0.97");
  });

  it("does not store a verdict when putObject fails", async () => {
    putObjectMock.mockRejectedValue(new Error("storage down"));

    await expect(POST(uploadRequest(jpegFixture))).rejects.toThrow("storage down");

    expect(verdictCreate).not.toHaveBeenCalled();
  });

  it("still stores the image when writing the verdict fails", async () => {
    // The bytes are already in storage; failing the upload now would lose an
    // image that exists. /api/puzzles treats a missing row as clean.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    verdictCreate.mockRejectedValue(new Error("db down"));

    const res = await POST(uploadRequest(jpegFixture));

    expect(res.status).toBe(201);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
