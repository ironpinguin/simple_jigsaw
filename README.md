# Jigsaw — Puzzles aus eigenen Bildern

Eine Web-App, mit der man aus eigenen Bildern klassische Puzzles (mit echten,
ineinandergreifenden Teilen) erzeugt und direkt im Browser löst. Puzzles lassen
sich speichern und über einen öffentlichen Link teilen — Lösen geht auch ohne
Konto.

## Stack

- **Next.js (App Router) + TypeScript** — UI und API in einem Codebase
- **React + Konva.js** — Rendering der Puzzleteile, Drag & Drop, Einrasten
- **Prisma + PostgreSQL** — Datenzugriff
- **Auth.js (NextAuth v5)** — E-Mail/Passwort-Login (JWT-Sessions)
- **sharp** — serverseitige Bildverarbeitung
- **RustFS / S3** — S3-kompatibler Bildspeicher

Alles läuft containerisiert über docker-compose (Dev und Prod).

Das Puzzle-Kernmodul liegt in `lib/puzzle/` und ist rein & getestet:

- `grid.ts` — Raster aus Teile-Anzahl + Seitenverhältnis
- `edges.ts` — geteilte Kanten (garantierte Passung Nase ↔ Bucht), seed-basiert
- `outline.ts` — SVG-Pfade der Teile

## Entwicklung (Docker, Hot-Reload)

`docker compose up` startet App + PostgreSQL + RustFS. Die
`docker-compose.override.yml` wird automatisch dazugemischt: die App läuft im
Dev-Modus (`next dev`) mit gemountetem Quellcode, Änderungen sind sofort live.
Beim Start wird das Prisma-Schema per `prisma db push` synchronisiert.

```bash
docker compose up --build     # http://localhost:3000
```

Ports: App `3000`, PostgreSQL `5432`, RustFS S3-API `9000`, RustFS-Konsole `9001`
(rustfsadmin / rustfsadmin).

Host-Tooling (z. B. `npx prisma studio`) gegen die Container:
`cp .env.example .env` — die Werte zeigen auf `localhost`.

## Deployment (Docker, Produktions-Build)

Nur die Basis-Compose ohne die Dev-Overrides verwenden — die App läuft dann als
optimiertes Produktions-Image (`next start`):

```bash
export AUTH_SECRET=$(openssl rand -base64 32)   # echtes Secret setzen!
docker compose -f docker-compose.yml up -d --build
```

Für echten Betrieb außerdem die RustFS-Zugangsdaten (`S3_ACCESS_KEY_ID`,
`S3_SECRET_ACCESS_KEY`) und ggf. das Postgres-Passwort setzen.

## Konten, Rollen & Admin

- **Registrierung mit E-Mail-Bestätigung**: Nach der Registrierung wird eine
  Bestätigungsmail verschickt; Login ist erst nach Klick auf den Link möglich.
  Im Dev landen alle Mails in **Mailpit** → http://localhost:8025.
- **Rollen**: `USER` / `ADMIN`. Admins sehen den Menüpunkt **Admin** und den
  Bereich unter `/admin`.
- **Admin wird man auf zwei Wegen**:
  - Env `ADMIN_EMAILS` (kommagetrennt) — diese Adressen werden bei
    Registrierung/Login automatisch zu Admin. Default in `.env`:
    `admin@example.com`.
  - CLI: `docker compose exec app npm run make-admin -- you@example.com`
- **Admin-Bereich** (`/admin`):
  - *Nutzer*: anlegen per **Einladung** (Mail-Link zum Passwort setzen) oder
    **direkt** (E-Mail + Startpasswort), Rolle umschalten, löschen.
  - *Banns*: E-Mail-Adressen oder ganze Domains sperren — gesperrte Adressen
    können sich weder registrieren noch anmelden.

Für Produktion echtes SMTP setzen (`SMTP_HOST/PORT/USER/PASS/FROM`), `APP_URL`
auf die öffentliche URL, und `ADMIN_EMAILS` passend wählen.

## Tests

```bash
npm install
npm test        # Vitest: Raster, Kanten-Passung, Outlines, Gruppen, Banns/Tokens
```

## Nicht in v1 (bewusst später)

Spielstand speichern, Bestenliste/Zeiten, Mehrspieler.
