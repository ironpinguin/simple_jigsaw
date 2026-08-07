import { tmpdir } from "os";
import path from "path";
import { promises as fs } from "fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyObject, getObject, putObject } from "./storage";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), "jigsaw-storage-"));
  process.env.STORAGE_FS_DIR = dir;
});

afterEach(async () => {
  delete process.env.STORAGE_FS_DIR;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("copyObject (fs driver)", () => {
  it("copies an object to a new key and leaves the source readable", async () => {
    await putObject("puzzles/src.webp", Buffer.from("img-bytes"), "image/webp");
    await copyObject("puzzles/src.webp", "puzzles/dest.webp");
    expect((await getObject("puzzles/dest.webp")).body.toString()).toBe("img-bytes");
    expect((await getObject("puzzles/src.webp")).body.toString()).toBe("img-bytes");
  });

  it("rejects when the source object does not exist", async () => {
    await expect(copyObject("puzzles/missing.webp", "puzzles/dest.webp")).rejects.toThrow();
  });
});
