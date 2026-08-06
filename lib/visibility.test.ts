import { describe, expect, it } from "vitest";
import { canViewPuzzle, imageCacheControl } from "./visibility";

const puzzle = (isPublic: boolean) => ({ isPublic, ownerId: "owner-1" });

describe("canViewPuzzle", () => {
  it("allows anyone to view a public puzzle", () => {
    expect(canViewPuzzle(puzzle(true), null)).toBe(true);
    expect(canViewPuzzle(puzzle(true), { id: "stranger", role: "USER" })).toBe(true);
  });

  it("denies a private puzzle to anonymous visitors", () => {
    expect(canViewPuzzle(puzzle(false), null)).toBe(false);
  });

  it("denies a private puzzle to a different signed-in user", () => {
    expect(canViewPuzzle(puzzle(false), { id: "stranger", role: "USER" })).toBe(false);
  });

  it("allows the owner to view their private puzzle", () => {
    expect(canViewPuzzle(puzzle(false), { id: "owner-1", role: "USER" })).toBe(true);
  });

  it("allows an admin to view any private puzzle", () => {
    expect(canViewPuzzle(puzzle(false), { id: "someone-else", role: "ADMIN" })).toBe(true);
  });
});

describe("imageCacheControl", () => {
  it("keeps the long immutable cache for public images", () => {
    expect(imageCacheControl(true)).toBe("public, max-age=31536000, immutable");
  });

  it("forbids caching for private images", () => {
    expect(imageCacheControl(false)).toBe("private, no-store");
  });
});
