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
- **next-intl** — Mehrsprachigkeit (DE/EN/IT) mit URL-Präfix-Routing

Alles läuft containerisiert über docker-compose (Dev und Prod).

## Sprachen

Die Oberfläche ist in **Deutsch** (Standard), **Englisch** und **Italienisch**
verfügbar. Die Sprache steckt im URL-Präfix (`/de`, `/en`, `/it`) und lässt sich
über den Umschalter in der Kopfzeile wechseln. Auch die transaktionalen E-Mails
(Bestätigung, Einladung) und die API-Fehlermeldungen sind übersetzt; die
E-Mail-Sprache folgt der zuletzt gewählten Sprache. Übersetzungen liegen als
JSON-Kataloge unter `messages/` — eine weitere Sprache besteht aus einer neuen
Locale in `i18n/routing.ts` plus `messages/<locale>.json`.

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

### Applaus austauschen

Beim Lösen eines Puzzles spielt `public/sounds/applause.mp3` (CC0, Quelle in
[NOTICE](NOTICE)). Die Datei wird zur Laufzeit ausgeliefert, lässt sich also
ohne neuen Build ersetzen, indem man per Volume eine eigene darüberlegt. Der
Produktionsstart oben (`-f docker-compose.yml`) mischt die
`docker-compose.override.yml` bewusst *nicht* dazu — die gehört dem Dev-Modus.
Das Volume kommt deshalb in eine eigene Datei, z. B. `docker-compose.applause.yml`:

```yaml
services:
  app:
    volumes:
      - ./mein-applaus.mp3:/app/public/sounds/applause.mp3:ro
```

```bash
docker compose -f docker-compose.yml -f docker-compose.applause.yml up -d
```

Mit `docker-compose.sqlite.yml` geht es genauso. Wer stattdessen die Datei im
Repo überschreibt, braucht für das Produktions-Image einen neuen Build
(`--build`), weil `public/` beim Bauen hineinkopiert wird; nur im Dev-Modus ist
der Quellcode gemountet und die neue Datei sofort da.

MP3 spielt in allen Browsern; ein paar Sekunden mit Ausblenden am Ende passen
am besten. Fehlt die Datei oder ist sie unlesbar, bleibt es still — das Banner
und das Feuerwerk kommen trotzdem.

## Minimal ohne Postgres (SQLite)

Die Datenbank ist zwischen **PostgreSQL** (Standard) und **SQLite** umschaltbar
über `DATABASE_PROVIDER`. Für eine kleine Installation ohne Postgres gibt es ein
eigenes, self-contained Compose:

```bash
docker compose -f docker-compose.sqlite.yml up -d --build   # http://localhost:3000
```

Das startet nur **app + mailpit**: die Daten liegen in einer **SQLite-Datei** und
die Bilder im **lokalen Dateisystem** (beides im Volume `sqlitedata`) — kein
Postgres, kein RustFS.

Es ist **dasselbe Image** wie für Postgres: Es enthält einen Prisma-Client für
jede Datenbank, und `DATABASE_PROVIDER` wählt beim Containerstart einen aus.
Umsteigen heißt also, die Variable (und `DATABASE_URL`) zu ändern, nicht ein
anderes Image zu bauen.

Hintergrund: `prisma/schema.prisma` ist die einzige Quelle; `scripts/prisma.mjs`
leitet für SQLite nur die `datasource`- und `output`-Zeile ab und erzeugt beide
Clients. Da Prisma-Enums auf SQLite nicht unterstützt werden, sind
Rollen-/Typ-Spalten Strings (validiert im Code, siehe `lib/roles.ts`).

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
- **Konten per CLI anlegen** (aktiv & bestätigt, umgeht die Bann-Liste):
  - `docker compose exec app npm run create-user -- user@example.com 'passwort'`
  - `docker compose exec app npm run create-user -- boss@example.com 'passwort' --admin`
- **Abgelaufene Links aufräumen**: Bestätigungs- und Einladungs-Tokens werden
  beim Einlösen gelöscht, abgelaufene automatisch — beim Start des Containers
  und danach stündlich (Art. 5 Abs. 1 lit. e DSGVO, Speicherbegrenzung). Ein
  Readiness-Check kann den nächsten Lauf vorziehen, löst aber höchstens einen
  Lauf pro Stunde aus. Eine laufende Instanz hält sich damit selbst sauber,
  ohne dass etwas eingerichtet werden muss. Für einen einmaligen Nachlauf auf
  einer länger laufenden Instanz:
  - `docker compose exec app npm run purge-expired`
  - Ob das Aufräumen tatsächlich läuft, sagt `/api/health/ready`: meldet es
    `"retention": "stale"`, sind mehrere Läufe hintereinander fehlgeschlagen —
    etwa fehlende Löschrechte oder eine volle Platte. Lesende Abfragen
    funktionieren dann weiter, der Container gilt weiter als gesund. Gemeldet
    werden beide Läufe, Tokens und verwaiste Klassifizierungsergebnisse; welcher
    davon klemmt, steht im Log. Die beiden hängen nicht voneinander ab: schlägt
    einer fehl, läuft der andere trotzdem.
- **Registrierung abschalten**: `REGISTRATION_ENABLED=false` setzen — die
  öffentliche Selbst-Registrierung ist dann deaktiviert (die Registrierungsseite
  zeigt einen Hinweis, die Links verschwinden). Einladungen, Admin-Anlage und die
  CLI bleiben davon unberührt.
- **Admin-Bereich** (`/admin`):
  - *Nutzer*: anlegen per **Einladung** (Mail-Link zum Passwort setzen) oder
    **direkt** (E-Mail + Startpasswort), Rolle umschalten, löschen. Wer eingeladen
    wurde, aber nie ein Passwort gesetzt hat, kann per **erneut einladen** eine
    frische Mail bekommen; der bisherige Link wird dabei ungültig.
  - *Banns*: E-Mail-Adressen oder ganze Domains sperren — gesperrte Adressen
    können sich weder registrieren noch anmelden.

Für Produktion echtes SMTP setzen (`SMTP_HOST/PORT/USER/PASS/FROM`), `APP_URL`
auf die öffentliche URL, und `ADMIN_EMAILS` passend wählen.

- **Bildklassifizierung (NSFW)**: optional und standardmäßig aus
  (`NSFW_MODE=off`). `local` prüft mit einem lokalen ONNX-Modell im Container
  (`NSFW_MODEL_PATH`) — bewertet werden dabei explizite *und* Gewaltdarstellungen,
  die das Modell getrennt ausweist. `external` schickt jedes hochgeladene Bild an
  einen Dienst unter `NSFW_API_URL`/`NSFW_API_KEY` — das macht ihn zu einem
  Auftragsverarbeiter, siehe [docs/data-processors.md](docs/data-processors.md),
  wo auch der erwartete HTTP-Kontrakt steht (der Dienst muss ihn sprechen; die
  APIs kommerzieller Anbieter tun das nicht ohne Adapter davor).
  Ein als möglicherweise problematisch erkanntes oder nicht klassifizierbares Bild wird
  trotzdem gespeichert, das Puzzle bleibt aber privat, landet in der
  Admin-Warteschlange und kann von der hochladenden Person nicht selbst
  veröffentlicht werden, bis ein Admin die Meldung entschieden hat; sie wird
  darauf hingewiesen. `.env.example` dokumentiert alle `NSFW_*`-Variablen.
- **Rechtliche Seiten**: `LEGAL_NAME`, `LEGAL_ADDRESS` und `LEGAL_EMAIL` sind
  Pflicht, bevor die Instanz öffentlich erreichbar ist — sonst zeigt
  `/legal/imprint` statt eines Impressums einen Hinweis auf die fehlenden
  Variablen. Läuft Mail, Bild-Speicher oder die Bildklassifizierung
  (`NSFW_MODE=external`) bei einem externen Anbieter, muss
  `LEGAL_MAIL_PROCESSOR`, `LEGAL_STORAGE_PROCESSOR` bzw.
  `LEGAL_CLASSIFIER_PROCESSOR` ihn benennen, sonst behauptet die
  Datenschutzerklärung Eigenbetrieb oder verschweigt einen echten
  Auftragsverarbeiter. `.env.example` erklärt alle `LEGAL_*`-Variablen im
  Detail.
- **Auftragsverarbeitung**: Welche personenbezogenen Daten die Instanz überhaupt
  verlassen und was pro externem Dienst zu klären ist (AV-Vertrag, Drittland),
  steht in [docs/data-processors.md](docs/data-processors.md) — mit einer
  Tabelle zum Ausfüllen für die eigene Instanz.
- **Reverse Proxy**: Läuft die App hinter nginx/traefik/Caddy, muss
  `TRUSTED_PROXY_HOPS` die Anzahl der eigenen Proxys angeben (1 = ein Proxy,
  2 = zusätzlich ein Load Balancer davor). Beim Standardwert `0` gilt
  `x-forwarded-for` als fälschbar und wird ignoriert: Meldungen teilen sich
  dann ein gemeinsames Stundenkontingent, und doppelte Meldungen zum selben
  Puzzle werden nicht mehr herausgefiltert.

## Tests

```bash
npm install
npm test        # Vitest: Raster, Kanten-Passung, Outlines, Gruppen, Banns/Tokens
```

## Releases

Releases werden per **SemVer-Tag** ausgelöst. Ein Tag `vX.Y.Z` startet die
Release-Jobs in GitHub Actions, die das Docker-Image mit Buildx bauen und in
die **GitHub Container Registry** (`ghcr.io/ironpinguin/simple_jigsaw`) pushen:

- `…:vX.Y.Z` und `…:latest` — für PostgreSQL und SQLite (`DATABASE_PROVIDER`)
- `…:vX.Y.Z-sqlite` und `…:latest-sqlite` — dasselbe Image, **veraltet**: nur
  noch für bestehende SQLite-Installationen und in einem späteren Release
  entfernt. Stattdessen `…:latest` mit `DATABASE_PROVIDER=sqlite`.

und einen GitHub-Release-Eintrag anlegt. Details in
[CONTRIBUTING.md](CONTRIBUTING.md).

```bash
git tag -a v0.1.0 -m "v0.1.0" && git push origin v0.1.0
```

## Lizenz

[Apache License 2.0](LICENSE) — © 2026 Michele Catalano.

## Nicht in v1 (bewusst später)

Spielstand speichern, Bestenliste/Zeiten, Mehrspieler.
