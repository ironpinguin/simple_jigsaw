# Spec: Natural piece shapes (classic tabs, light jitter, 3D shading)

_Datum: 2026-07-26_

## Kontext & Ziel

Die aktuellen Puzzleteile wirken zu gleichförmig/„blobbig" (ein Bulb-Knopf pro
Kante, flach). Vorbild ist Jigsaw Explorer: **regelmäßiges Raster**, **klassische
Knöpfe** (eingeschnürter Hals + Hinterschnitt) und ein **3D-Look** (feine Fase +
weicher Schlagschatten), der die Teile wie echte Pappteile wirken lässt.

Entscheidungen (mit dem Nutzer abgestimmt):
- Klassische Knopfform mit Hals-Einschnürung/Hinterschnitt.
- Regelmäßiges Raster mit **leichtem** Vertex-Jitter (organischer als die Referenz).
- **Dezente 3D-Schattierung** (Schlagschatten + Kanten-Fase).

Passung und Löse-Mechanik bleiben unverändert; alles seed-reproduzierbar.

## `lib/puzzle/`

### edges.ts
- `EdgeGrid` bekommt ein **Vertex-Raster** `vertices[r][c] = { dx, dy }`
  (Offset in Zell-Bruchteilen; auf dem Rand `0`, innen seed-basiert
  `±J`, J ≈ 0.07 „leicht"). Nachbarn teilen dieselben Vertices.
- Interior-Kanten behalten `sign` + Jitter, jetzt für das klassische Template.

### outline.ts
- Neues **klassisches Knopf-Template** (Hals-Einschnürung, Kopf breiter als Hals
  = Hinterschnitt), mit feiner Jitter (Position, Größe, leichte Asymmetrie).
- `edgePoints(a, b, sign, …)` berechnet die **Senkrechte aus dem Kantenvektor**
  (statt achsenparallel), da Kanten durch den Jitter leicht schräg sind.
- `pieceEdgePoints`/`pieceOutlinePath` bauen das Teil aus seinen **4 (verschobenen)
  Eck-Vertices** + 4 geteilten Kanten, in Teil-lokalen Koordinaten
  (Ursprung = reguläre Zellecke `(col·pieceW, row·pieceH)`). Border-Vertices = 0.
- Passung bleibt garantiert: Nachbarn teilen Vertices **und** Kanten → gemeinsame
  Grenzkurve identisch (eine vorwärts, eine rückwärts).

## `components/PuzzleBoard.tsx`

- **Variable Teilgröße:** Offscreen-Canvas je Teil aus der tatsächlichen
  **Umriss-Bounding-Box** (min/max der Outline-Punkte) + Rand; `offsetX/offsetY`
  so setzen, dass `node.x/y` weiterhin die reguläre Zellecke ist (Anker/Einrasten
  unverändert).
- **Schlagschatten:** Konva-`shadowColor/Blur/Offset` am Teil-Node (weich, dezent).
- **Fase/Emboss:** beim Zeichnen ins Offscreen-Canvas nach dem Clip die Kontur
  zweifach nachziehen — heller Strich leicht nach oben-links, dunkler nach
  unten-rechts (innerhalb des Clips) → Tiefe.

## Tests (Vitest)
- Determinismus: gleicher Seed → gleiche Vertices/Kanten.
- Passung: `pieceEdgePoints` Nachbar-Grenzen identisch (verschobene Bottom==Top,
  Right==Left) — gilt weiterhin, da Vertices+Kanten geteilt sind.
- Outline: gültiger geschlossener SVG-Pfad.

## Verifikation
- In der App ein Puzzle rendern, per Screenshot gegen den Ziellook prüfen
  (klassische Knöpfe, dezente Tiefe, leicht variierte Teile), Einrasten testen.
