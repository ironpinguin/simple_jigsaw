import { describe, expect, it } from "vitest";
import { canViewPuzzle, evaluateImageAccess, toViewer } from "./visibility";

const puzzle = (isPublic: boolean, ownerId = "owner-1") => ({ isPublic, ownerId });

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

describe("toViewer", () => {
  it("maps a user row to a viewer", () => {
    expect(toViewer({ id: "u1", role: "ADMIN" })).toEqual({ id: "u1", role: "ADMIN" });
  });

  it("returns null for a missing user", () => {
    expect(toViewer(null)).toBeNull();
    expect(toViewer(undefined)).toBeNull();
  });

  it("downgrades an unknown role string to USER", () => {
    expect(toViewer({ id: "u1", role: "moderator" })).toEqual({ id: "u1", role: "USER" });
  });
});

describe("evaluateImageAccess", () => {
  it("denies a key no puzzle references, even to an admin", () => {
    expect(evaluateImageAccess([], null)).toEqual({ allowed: false });
    expect(evaluateImageAccess([], { id: "a", role: "ADMIN" })).toEqual({ allowed: false });
  });

  it("serves publicly cacheable (one day, no immutable) when any referencing puzzle is public", () => {
    const access = evaluateImageAccess([puzzle(false, "owner-a"), puzzle(true, "owner-b")], null);
    expect(access).toEqual({ allowed: true, cacheControl: "public, max-age=86400" });
  });

  it("denies a private-only image to anonymous visitors and strangers", () => {
    expect(evaluateImageAccess([puzzle(false)], null)).toEqual({ allowed: false });
    expect(evaluateImageAccess([puzzle(false)], { id: "stranger", role: "USER" })).toEqual({
      allowed: false,
    });
  });

  it("serves a private image uncached to the owner of any referencing puzzle", () => {
    const access = evaluateImageAccess(
      [puzzle(false, "owner-a"), puzzle(false, "owner-b")],
      { id: "owner-b", role: "USER" },
    );
    expect(access).toEqual({ allowed: true, cacheControl: "private, no-store" });
  });

  it("serves a private image uncached to an admin", () => {
    expect(evaluateImageAccess([puzzle(false)], { id: "x", role: "ADMIN" })).toEqual({
      allowed: true,
      cacheControl: "private, no-store",
    });
  });
});
