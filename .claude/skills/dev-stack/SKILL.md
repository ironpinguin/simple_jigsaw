---
name: dev-stack
description: Use when running this app locally, verifying a change in the browser, or needing a test account, an admin, or a look at a sent email.
---

# Running the app

Everything runs in Docker. There is no supported `npm run dev` on the host — the
app expects the database, the S3 store and the mail catcher next to it.

## Which stack

| Goal | Command | What you get |
| --- | --- | --- |
| **Development** (default) | `docker compose up --build` | app in `next dev` with the source mounted, Postgres, RustFS, Mailpit |
| **Minimal, no Postgres** | `docker compose -f docker-compose.sqlite.yml up -d --build` | app + Mailpit only; SQLite file + filesystem storage in the `sqlitedata` volume |
| **Production build** | `docker compose -f docker-compose.yml up -d --build` | optimised `next start`, **no** Mailpit — needs real SMTP and `AUTH_SECRET` |

`docker-compose.override.yml` is merged automatically by plain
`docker compose up`; that is what turns the app into dev mode and runs
`prisma generate && prisma db push` before `next dev`. Naming
`-f docker-compose.yml` explicitly *skips* the override — that is the production
path, and hot reload will be gone.

| Port | Service |
| --- | --- |
| 3000 | app |
| 8025 | Mailpit web UI (1025 = SMTP) |
| 5432 | PostgreSQL |
| 9000 / 9001 | RustFS S3 API / console (`rustfsadmin` / `rustfsadmin`) |

## Accounts

Registration sends a confirmation mail — in dev it lands in Mailpit
(http://localhost:8025), and login only works after the link is clicked. Skip
that with the CLI:

```bash
docker compose exec app npm run create-user -- user@example.com 'passwort'
docker compose exec app npm run create-user -- boss@example.com 'passwort' --admin
docker compose exec app npm run make-admin -- you@example.com
```

`ADMIN_EMAILS` in `.env` auto-promotes on register/login;
`REGISTRATION_ENABLED=false` closes public signup without touching invites or
the CLI.

## Host tooling

```bash
cp .env.example .env      # values point at localhost
npx prisma studio
```

## Verifying a change

```bash
curl -s -o /dev/null -w "%{http_code}\n" --max-time 2 http://localhost:3000/
docker compose logs -f app
```

The app is locale-prefixed: `/de`, `/en`, `/it` — `/` redirects. When a change
touches email or a locale, check it in Mailpit and in more than one language.

## Common mistakes

- **`-f docker-compose.yml` for development.** That drops the override and runs
  a production build; edits stop showing up.
- **Forgetting `--build`** after a dependency or Dockerfile change — the
  container keeps the old `node_modules`.
- **Expecting mail in the production stack.** Mailpit only exists in the dev
  override and the SQLite compose.
- **Mixing the two stacks' state.** They use separate volumes; a user created in
  one does not exist in the other.
