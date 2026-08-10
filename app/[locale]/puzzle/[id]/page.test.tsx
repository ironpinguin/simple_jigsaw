import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// House style for server logic that touches Prisma/auth: mock the two calls
// and exercise the exported function directly (see
// app/api/puzzles/[id]/route.test.ts). This is a Server Component, not a
// route handler, but it is still a plain async function returning a React
// element — no DOM, no client render, is needed to see whether the note is
// in the tree, so this stays in the same node-environment style rather than
// pulling in a component-rendering harness this repo does not otherwise use.
const { findUnique, getSessionViewerMock, notFoundMock } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  getSessionViewerMock: vi.fn(),
  notFoundMock: vi.fn(() => {
    // Mirrors next/navigation's notFound(): it throws rather than returning,
    // so code after it must never run — same as in production.
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("@/lib/db", () => ({ prisma: { puzzle: { findUnique } } }));
vi.mock("@/lib/auth", () => ({ getSessionViewer: getSessionViewerMock }));
vi.mock("next/navigation", () => ({ notFound: notFoundMock }));
vi.mock("next-intl/server", () => ({
  setRequestLocale: vi.fn(),
  getTranslations: async () => (key: string) => key,
}));
// PuzzleSolver drags in next/dynamic + Konva, which need a browser; the
// ownership/review-note logic under test never looks inside it.
vi.mock("@/components/PuzzleSolver", () => ({ default: () => null }));

import PuzzlePage from "./page";

const PUZZLE = {
  id: "p1",
  title: "T",
  imageKey: "puzzles/abc.webp",
  imageWidth: 800,
  imageHeight: 600,
  pieceCount: 48,
  seed: 7,
  isPublic: false,
  ownerId: "owner-1",
};

function callPage(searchParams: { review?: string } = {}) {
  return PuzzlePage({
    params: Promise.resolve({ locale: "en", id: "p1" }),
    searchParams: Promise.resolve(searchParams),
  });
}

/** Pull the review-note paragraph's text out of the page's returned tree, if present. */
function noteText(page: ReactElement): string | null {
  const children = (page.props as { children: ReactNode[] }).children;
  const note = children.find(
    (child): child is ReactElement =>
      typeof child === "object" && child !== null && (child as ReactElement).type === "p",
  );
  if (!note) return null;
  return String((note.props as { children: unknown }).children);
}

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue(PUZZLE);
});

describe("PuzzlePage review note — who can see it", () => {
  it("shows the note to the owner of a held-back puzzle with ?review=1", async () => {
    getSessionViewerMock.mockResolvedValue({ id: "owner-1", role: "USER" });
    const page = await callPage({ review: "1" });
    expect(noteText(page)).toBe("reviewPending");
  });

  it("sends a different logged-in user down the 404 path — no note, no puzzle", async () => {
    getSessionViewerMock.mockResolvedValue({ id: "stranger", role: "USER" });
    await expect(callPage({ review: "1" })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFoundMock).toHaveBeenCalled();
  });

  it("sends an anonymous visitor down the 404 path — no note, no puzzle", async () => {
    getSessionViewerMock.mockResolvedValue(null);
    await expect(callPage({ review: "1" })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFoundMock).toHaveBeenCalled();
  });

  it("never shows the note on a public puzzle, even to its owner, and never even checks who is viewing", async () => {
    // A public puzzle's isPublic branch is skipped entirely, so the session
    // is never resolved — the strongest form of "no note leaks" available:
    // there is no owner check left to get wrong.
    findUnique.mockResolvedValue({ ...PUZZLE, isPublic: true });
    const page = await callPage({ review: "1" });
    expect(noteText(page)).toBeNull();
    expect(getSessionViewerMock).not.toHaveBeenCalled();
  });

  it("does not show the note to an admin viewing someone else's held-back puzzle", async () => {
    // An admin passes canViewPuzzle (so they are not sent to the 404 path
    // like a stranger), which makes this the one case that actually
    // exercises the `viewer?.id === puzzle.ownerId` term: the note is
    // addressed to the uploader, not to anyone who is merely allowed to look.
    getSessionViewerMock.mockResolvedValue({ id: "admin-1", role: "ADMIN" });
    const page = await callPage({ review: "1" });
    expect(noteText(page)).toBeNull();
  });
});
