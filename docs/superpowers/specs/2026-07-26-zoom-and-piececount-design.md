# Spec: Zoom/Pan + per-solver piece count

_Datum: 2026-07-26_

## Kontext & Ziel

Auf Tablets (und kleinen Fenstern) sind die Teile zu klein. Zwei Verbesserungen
(beide gewünscht):

1. **Zoom/Pan** der Löse-Fläche — universell, ändert das Puzzle nicht.
2. **Teile-Anzahl pro Löser** — jeder wählt die Anzahl selbst; Ersteller-Wert
   ist der Default. Weniger Teile = größere Teile.

## A. Zoom & Pan (`components/PuzzleBoard.tsx`)

- Konva-Stage per Ref, **unkontrolliert** transformiert (kein React-Re-render pro
  Zoom): `scale` + `position` imperativ setzen, `batchDraw()`.
- **Zoom-Quellen:** Mausrad (zoomt auf den Cursor), On-Screen-Buttons **+ / − /
  Reset**, und **Pinch-to-Zoom** (zwei Finger; zoomt auf den Mittelpunkt).
  Clamp ~0.35×–3×. „Reset" = scale 1, position (0,0).
- **Pan:** Stage `draggable` → Ziehen auf leerer Fläche verschiebt die Fläche.
  Teile bleiben einzeln ziehbar (Gruppen fangen ihr eigenes Dragging ab).
  Während eines Pinch (2 Pointer) wird `draggable` kurz deaktiviert.
- **Löse-Logik unverändert:** Einrasten arbeitet in Layer-Koordinaten
  (`group.x/y`), unabhängig von Stage-`scale`/`position`.
- Buttons als kleines HTML-Overlay im `board-wrap` (Ecke); `board-wrap` von
  `overflow:auto` auf `overflow:hidden` (Pan ersetzt das Scrollen; behebt den
  horizontalen Scrollbalken).

## B. Teile-Anzahl pro Löser (`components/PuzzleSolver.tsx`)

- State `pieceCount`, initial aus `localStorage["pc:<id>"]` sonst
  `puzzle.pieceCount`.
- `cols/rows` clientseitig aus `computeGrid(pieceCount, imageW/imageH)`
  (`lib/puzzle/grid.ts`, bereits getestet) und an `PuzzleBoard` durchgereicht
  (statt `puzzle.cols/rows`). Seed & Bild bleiben.
- **Selector** (Presets 12/48/108/300) in der Toolbar; Default = Ersteller-Wert.
- Wechsel: falls schon Teile verbunden (`groups < total`), **Rückfrage**; dann
  `pieceCount` setzen, in localStorage merken → `PuzzleBoard` baut neu (neue
  Teile, Fortschritt startet neu).
- Keine DB-/API-Änderung (Ersteller-Default ist bereits gespeichert).

## Schnittstellen
- `PuzzleBoard` bekommt `cols`/`rows` als Props (überschreiben `puzzle.cols/rows`);
  `total = cols*rows`.
- `PuzzleSolver` hält `pieceCount`, rechnet `cols/rows`, rendert Selector + Board.

## Verifikation
- Desktop (echter Chrome): Rad-Zoom, +/−/Reset, Pan auf leerer Fläche, Teile
  weiter ziehbar; Anzahl wechseln → neue Teilegröße; kein horizontaler Scrollbar.
- Touch: Chrome-Touch-Emulation → Pinch-Zoom, Ein-Finger-Pan, Teil-Ziehen.
- `computeGrid` ist unit-getestet; Zoom-Mathe bei Bedarf als kleine reine
  Funktion prüfbar.
