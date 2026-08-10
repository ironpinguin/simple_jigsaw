# Security Policy / Sicherheitsrichtlinie

## Supported versions / Unterstützte Versionen

Fixes go into the latest release only. There are no maintained release
branches — a security fix ships as the next version and the previous images are
not patched in place.

| Version | Supported |
| --- | --- |
| 0.6.x | ✅ |
| < 0.6 | ❌ |

Container images follow the same rule: `ghcr.io/ironpinguin/simple_jigsaw:latest`
(and `:latest-sqlite`) track the newest release. A published tag is never moved —
if something is wrong with a release, it is fixed forward in the next one.

---

## English

**Please do not open a public issue for a security problem.**

Report it through GitHub's private vulnerability reporting: go to the
[Security tab](https://github.com/ironpinguin/simple_jigsaw/security) and choose
*Report a vulnerability*. That channel is private between you and the
maintainer.

Useful in a report:

- what an attacker can do, not just what looks wrong
- the affected version or commit, and which database provider (PostgreSQL or
  SQLite) if it matters
- steps to reproduce, ideally against a local `docker compose up` stack
- whether the issue needs an authenticated account, and which role

What to expect: an acknowledgement, and a decision on whether it is a
vulnerability or a plain bug. This is a hobby project maintained by one person,
so please allow for real-world response times rather than a fixed SLA. You will
be credited in the release notes unless you prefer otherwise.

**In scope:** authentication and session handling, the admin area and its role
checks, puzzle visibility (a private puzzle's image or metadata reaching someone
who should not see it), image upload and processing, the token flows for email
confirmation and invitations, and anything that lets one account act as another.

**Out of scope:** findings that only apply to the development stack — the
`dev-insecure-secret-change-me-in-production-000000` default for `AUTH_SECRET`,
Mailpit, the RustFS console credentials, and the other placeholders in
`.env.example` and the compose files are development conveniences and are
documented as such. The same goes for missing rate limits on endpoints that are
not exposed publicly, and for reports produced purely by an automated scanner
without a working exploit path.

---

## Deutsch

**Bitte kein öffentliches Issue für ein Sicherheitsproblem anlegen.**

Meldung über GitHubs private Schwachstellenmeldung: im
[Security-Tab](https://github.com/ironpinguin/simple_jigsaw/security) den Punkt
*Report a vulnerability* wählen. Dieser Kanal ist privat zwischen dir und dem
Maintainer.

Hilfreich in einer Meldung:

- was ein Angreifer damit tun kann, nicht nur was auffällig aussieht
- betroffene Version oder Commit, und falls relevant der Datenbank-Provider
  (PostgreSQL oder SQLite)
- Schritte zur Reproduktion, idealerweise gegen ein lokales
  `docker compose up`
- ob ein angemeldetes Konto nötig ist und mit welcher Rolle

Was du erwarten kannst: eine Empfangsbestätigung und eine Einschätzung, ob es
sich um eine Schwachstelle oder einen gewöhnlichen Bug handelt. Das Projekt wird
von einer Person in der Freizeit betreut — bitte rechne mit realistischen
Antwortzeiten statt mit einer zugesicherten Frist. Auf Wunsch wirst du in den
Release Notes genannt.

**Im Geltungsbereich:** Authentifizierung und Session-Handling, der
Admin-Bereich und seine Rollenprüfungen, die Sichtbarkeit von Puzzles (wenn Bild
oder Metadaten eines privaten Puzzles jemanden erreichen, der sie nicht sehen
darf), Bild-Upload und -Verarbeitung, die Token-Abläufe für Bestätigungs- und
Einladungslinks sowie alles, was ein Konto im Namen eines anderen handeln lässt.

**Außerhalb des Geltungsbereichs:** Funde, die nur den Entwicklungs-Stack
betreffen — der Standardwert
`dev-insecure-secret-change-me-in-production-000000` für `AUTH_SECRET`, Mailpit,
die RustFS-Konsolen-Zugangsdaten und die übrigen Platzhalter in `.env.example`
und den Compose-Dateien sind bewusste Entwicklungs-Vereinfachungen und als
solche dokumentiert. Ebenso fehlende Rate-Limits auf nicht öffentlich
erreichbaren Endpunkten und Meldungen, die allein aus einem automatischen
Scanner stammen, ohne dass ein Angriffsweg gezeigt wird.

---

## Operating this app yourself / Eigener Betrieb

If you deploy Jigsaw, the security of your instance is yours. The two things
that most often go wrong:

- **`AUTH_SECRET`** — the compose files carry an obvious development default.
  Generate a real one (`openssl rand -base64 32`) for anything reachable from
  outside your machine.
- **Storage and mail credentials** — `S3_SECRET_ACCESS_KEY`, `SMTP_PASS` and
  `NSFW_API_KEY` belong in a `.env` file or a secret store, never in a committed
  file. `/deploy/kubernetes/secret.yaml` is git-ignored for that reason.

[README.md](README.md) documents every variable; `docs/data-processors.md`
records which personal data can leave an instance and where it goes.
