---
name: puzzle-geometry
description: Use when working on piece shapes, the grid, scatter placement, snapping or group merging in this repo — anything under lib/puzzle/ or the board rendering that sits on top of it.
---

# The puzzle core

`lib/puzzle/` is pure, deterministic and unit-tested. `components/PuzzleBoard`
adds only rasterising and Konva event wiring on top. Keep it that way: no React,
no canvas, no I/O in this directory — that is what makes the geometry testable
in plain node.

| File | Responsibility |
| --- | --- |
| `prng.ts` | `mulberry32(seed)` + `uniform` — the only randomness allowed |
| `grid.ts` | `computeGrid(pieceCount, aspect)` → near-square `cols × rows`; `PIECE_PRESETS` |
| `edges.ts` | `generateEdges(cols, rows, seed)` → shared edge + vertex grid |
| `outline.ts` | `pieceOutlinePoints` / SVG path in the piece's local space; exports `TAB` |
| `board.ts` | stage + picture size, piece bitmap boxes, scatter, drag clamping |
| `groups.ts` | piece ids, neighbours, snapping, group merge cascade |
| `zoom.ts` | `StageView`, the scale limits, wheel/readout maths |
| `minimap.ts` | board overview: thumbnail size, visible rect, group markers |

## The invariants — break one and pieces stop fitting

**Edges are stored once and shared.** `EdgeGrid.horiz[r][c]` / `vert[r][c]` hold
*one* object per boundary, and `vertices[r][c]` one offset per grid vertex. Both
neighbours read the same object, so one piece's tab is exactly the other's
blank, traced in the opposite direction. Never generate a piece's four edges
from the piece — always index into the shared grid.

**The outer border is flat**, and border vertices are not jittered, so the
assembled picture stays a clean rectangle.

**Everything is seeded.** Same `(cols, rows, seed)` ⇒ identical output, which is
why a shared link looks the same for everyone. Use `mulberry32(seed)`; a bare
`Math.random()` anywhere in here is a bug. Consequence: changing the jitter
ranges or the knob template silently changes the shape of *already shared*
puzzles. That is a deliberate decision, not a refactor.

**Piece ids are `` `${row}-${col}` ``** (`pieceId` / `parsePieceId`), and inside
a group a piece always sits at `(col*pieceW, row*pieceH)` relative to the group
origin. Two groups are correctly adjacent exactly when their origins coincide —
which is why snapping compares origins, not piece corners.

**`TAB` lives in `outline.ts` and is imported by `board.ts`** so the bitmap is
big enough for the knob. Don't re-declare the protrusion factor.

## Testing

Assert the invariant, not the pixels. Three test files cover the module:
`puzzle.test.ts` (grid, edge determinism, "shares an identical boundary with the
piece below"), `board.test.ts` (bitmap contains the whole outline, scatter covers
every id once, clamped groups stay inside the stage) and `groups.test.ts`.

```bash
npx vitest run lib/puzzle
```

Good assertions: same seed ⇒ deep-equal output; different seeds ⇒ different;
neighbouring outlines share point-for-point coordinates; every generated rect
lies inside the stage; every piece id appears exactly once.

## Common mistakes

- Importing React, Konva or `window` into `lib/puzzle/` — it stops being
  testable and the module is used server-side too.
- Randomising per piece instead of per shared edge — the puzzle looks right and
  stops fitting.
- Rendering-only fixes for geometry bugs (nudging in `PuzzleBoard` instead of
  fixing `board.ts`), which leaves the unit tests happily green.
- Forgetting that a "cosmetic" constant change alters existing shared puzzles.
