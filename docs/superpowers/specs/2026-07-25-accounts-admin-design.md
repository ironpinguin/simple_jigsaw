# Spec: Konten, Rollen & Admin-Verwaltung

_Datum: 2026-07-25_

## Kontext & Ziel

Die Registrierung akzeptiert aktuell jede formal gültige E-Mail ohne Besitz-
nachweis, und es gibt keine Rollen. Ziel: **E-Mail-Bestätigung per Link**, ein
**Rollensystem** (User/Admin) und ein **Admin-Bereich** zur Nutzerverwaltung
(Konten anlegen/löschen, Rollen setzen) inkl. **Bann-Liste** für E-Mail-Adressen
und ganze Domains.

Bestand: Next.js App Router, Auth.js (Credentials, JWT-Sessions), Prisma +
PostgreSQL, `User { id, email, name?, passwordHash, createdAt }`, `getSessionUser()`
in `lib/auth.ts`.

## Entscheidungen

- **E-Mail-Validierung** = echte Bestätigung per Link (E-Mail-Versand nötig).
- **Admin-Bootstrapping**: beides — Env `ADMIN_EMAILS` **und** CLI `make-admin`.
- **Konto-Anlage durch Admin**: beides — Einladung per Mail **und** Direkt mit
  Initialpasswort.
- **Bann** sperrt **Registrierung und Login** für passende Adressen/Domains;
  bestehende Konten bleiben in der DB (Admin kann separat löschen).
- Rollen bewusst schlank: nur `USER`/`ADMIN`. Öffentliche Registrierung bleibt.
  Admins können andere zu Admin machen. Kein Passwort-Reset in diesem Schritt.

## Datenmodell (Prisma)

```
enum Role { USER ADMIN }
enum TokenType { EMAIL_VERIFY INVITE }
enum BanType { EMAIL DOMAIN }

model User {
  ... bestehende Felder ...
  role          Role      @default(USER)
  emailVerified DateTime?
  tokens        VerificationToken[]
}

model VerificationToken {
  id        String    @id @default(cuid())
  token     String    @unique
  type      TokenType
  userId    String
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  expiresAt DateTime
  createdAt DateTime  @default(now())
}

model BannedEmail {
  id        String   @id @default(cuid())
  value     String   @unique   // lowercased; bei DOMAIN nur der Domain-Teil
  type      BanType
  createdAt DateTime @default(now())
}
```

## Komponenten

### E-Mail-Versand — `lib/mail.ts`
- `nodemailer`-Transport aus `SMTP_HOST/PORT/USER/PASS/FROM`.
- `sendVerificationEmail(to, url)`, `sendInviteEmail(to, url)` (Text + einfaches HTML).
- Links werden aus `APP_URL` gebaut.

### Bann-Logik — `lib/bans.ts` (rein, testbar)
- `normalizeEmail(email)`, `domainOf(email)`.
- `isBanned(email, bans)` bzw. DB-Variante: exakte Adresse **oder** Domain-Match,
  case-insensitive.

### Token — `lib/tokens.ts`
- `createToken(userId, type)` (zufälliger Token, Ablauf 24 h für Verify, 7 Tage
  für Invite), `consumeToken(token, type)` prüft Gültigkeit/Ablauf und löscht ihn.

### Auth-Änderungen — `lib/auth.ts`
- `authorize`: nach Passwortprüfung zusätzlich (a) `isBanned` → ablehnen,
  (b) `emailVerified == null` → ablehnen. `ADMIN_EMAILS` → Rolle ggf. auf ADMIN
  heben (bei Login).
- `getSessionUser()` liefert zusätzlich `role`. Neuer Helfer `requireAdmin()`.
- JWT/Session tragen `role` (für UI-Gating).

### Registrierung — `app/api/register` + Seiten
- Bann-Prüfung → User `emailVerified=null` (Rolle ADMIN falls in `ADMIN_EMAILS`)
  → `EMAIL_VERIFY`-Token → Bestätigungsmail. **Kein Auto-Login.** UI-Hinweis.
- `app/verify/page.tsx` (+ `GET /api/verify`): Token einlösen → `emailVerified=now`.

### Admin-Bereich — `app/admin/*` (nur ADMIN)
- **Nutzer** (`/admin/users`): Liste + Aktionen Löschen, Rolle-Toggle,
  Konto anlegen (Einladung ODER Direkt mit Passwort).
- **Banns** (`/admin/bans`): Liste, hinzufügen (Wert + Typ), entfernen.
- APIs: `POST/GET /api/admin/users`, `POST /api/admin/users/invite`,
  `PATCH/DELETE /api/admin/users/[id]`, `GET/POST /api/admin/bans`,
  `DELETE /api/admin/bans/[id]` — alle `requireAdmin`.
- Invite-Annahme: `app/invite/page.tsx` (+ `POST /api/invite`): Token gültig →
  Passwort setzen → `passwordHash` + `emailVerified=now`.

### Bootstrapping
- Env `ADMIN_EMAILS` (kommagetrennt) → Auto-Promote bei Registrierung/Login.
- CLI `scripts/make-admin.ts`, Script `make-admin` in package.json.

### Infra & Env
- `docker-compose.override.yml`: **Mailpit** (`axllent/mailpit`, SMTP `1025`,
  UI `8025`). App-Env (base): `ADMIN_EMAILS`, `SMTP_*` (Default → mailpit),
  `APP_URL` (Default `http://localhost:3000`). Prod: echtes SMTP setzen.

## Fehlerfälle
- Ungültiger/abgelaufener Token → klare Meldung, kein Absturz.
- Gebannte Adresse bei Registrierung/Invite/Login → 403 mit Hinweis.
- Unbestätigte E-Mail bei Login → Meldung „Bitte E-Mail bestätigen".
- Admin-Route ohne Admin-Rolle → 403 (API) bzw. Redirect (Seite).
- Letzten Admin nicht versehentlich löschen/degradieren → Guard (mind. 1 Admin).

## Tests
- **Unit (Vitest, rein)**: `isBanned` (exakt + Domain, case-insensitive),
  `domainOf`, Token-Ablaufprüfung, `ADMIN_EMAILS`-Parsing.
- **Manuell E2E (Mailpit)**: Registrieren→Mail→Verify→Login; Admin-Invite→Mail→
  Passwort→Login; Admin Direkt-Anlage→Login; Domain bannen→Registrierung+Login
  blockiert; Nutzer löschen; Rolle-Toggle.

## Bewusst nicht in diesem Schritt
Passwort-Reset, feingranulare Rechte über USER/ADMIN hinaus, Rate-Limiting,
Audit-Log.
