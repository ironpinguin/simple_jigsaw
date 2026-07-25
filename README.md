# Jigsaw — Puzzles aus eigenen Bildern

Eine Web-App, mit der man aus eigenen Bildern klassische Puzzles (mit echten,
ineinandergreifenden Teilen) erzeugt und direkt im Browser löst. Puzzles lassen
sich speichern und über einen öffentlichen Link teilen — Lösen geht auch ohne
Konto.

## Stack

- **Next.js (App Router) + TypeScript** — UI und API in einem Codebase
- **React + Konva.js** — Rendering der Puzzleteile, Drag & Drop, Einrasten
- **Prisma** — Datenzugriff (SQLite in Dev, PostgreSQL in Prod)
- **Auth.js (NextAuth v5)** — E-Mail/Passwort-Login (JWT-Sessions)
- **sharp** — serverseitige Bildverarbeitung
- **Speicher** — lokales Dateisystem (Dev) oder S3/MinIO (Prod)

Das Puzzle-Kernmodul liegt in `lib/puzzle/` und ist rein & getestet:

- `grid.ts` — Raster aus Teile-Anzahl + Seitenverhältnis
- `edges.ts` — geteilte Kanten (garantierte Passung Nase ↔ Bucht), seed-basiert
- `outline.ts` — SVG-Pfade der Teile

## Schnellstart (ohne Docker)

Läuft komplett ohne externe Dienste (SQLite + Dateisystem):

```bash
npm install
cp .env.example .env          # Standardwerte funktionieren für Dev
npx prisma db push            # legt prisma/dev.db an
npm run dev                   # http://localhost:3000
```

`AUTH_SECRET` in `.env` für echten Betrieb neu erzeugen:
`npx auth secret` oder `openssl rand -base64 32`.

## Tests

```bash
npm test        # Vitest: Raster, Kanten-Passung, Outlines
```

## Produktionsstack (PostgreSQL + MinIO)

1. `docker compose up -d` (Postgres + MinIO)
2. In `.env`:
   - `DATABASE_URL="postgresql://jigsaw:jigsaw@localhost:5432/jigsaw?schema=public"`
   - `STORAGE_DRIVER="s3"`
3. In `prisma/schema.prisma` den `provider` auf `postgresql` setzen.
4. `npx prisma migrate deploy` (bzw. `migrate dev` beim ersten Mal)
5. `npm run build && npm start`

## Nicht in v1 (bewusst später)

Spielstand speichern, Bestenliste/Zeiten, Mehrspieler.
