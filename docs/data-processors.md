# Data processors: what leaves the instance, and what to sign for it

Decision for issue #24 — GDPR Art. 28. This file is for whoever operates an
instance of this app. It lists what personal data can leave the machine, which
external services see it, and what each operator has to settle before going
live. The list of services is deployment-specific; the list of *data flows*
below is not, because it follows from the code.

Art. 28 requires a written agreement (a DPA) with anyone who processes personal
data on your behalf. Self-hosting a component means there is no third party and
therefore nothing to sign — but it is still worth recording, because "we host it
ourselves" is exactly the claim the privacy policy makes on your behalf.

## What can leave the instance

Four routes out, and no others. Everything else the app stores stays in its own
Postgres/SQLite database and its own object storage.

### 1. Outbound mail (`lib/mail.ts`)

Every message goes through the SMTP server named by `SMTP_HOST`. Four kinds are
sent, and they do not all carry the same data:

| Message | Recipient | What the SMTP server sees |
| --- | --- | --- |
| Email confirmation | the person registering | their address, and a link containing a token that verifies the address |
| Invitation | the invited address | that address, and a link containing a token that **sets the account's first password** |
| Report notification | every admin | the admin's address, the reported puzzle's **title** and category — not the reporter's address |
| Takedown notice | the puzzle's owner | their address and the puzzle's title |

Two things are easy to miss here. The invite link is a credential: whoever reads
that mail can take over the account until the token expires, so the SMTP
provider is not merely handling addresses. And the last two message types carry
a puzzle title, which is user-supplied free text and can contain anything the
uploader typed.

`SMTP_HOST=mailpit` in the dev stack is a local catcher and reaches no third
party.

### 2. Object storage (`lib/storage.ts`)

Only when `STORAGE_DRIVER=s3`. The provider behind `S3_ENDPOINT` receives the
uploaded image bytes and the app-minted key (`puzzles/<uuid>.<ext>`), nothing
else — no account id, no filename from the user's disk. The images themselves
are the sensitive part: they are arbitrary uploads and routinely contain
photographs of identifiable people.

With the default `STORAGE_DRIVER=fs` the files stay on a local volume and no
third party is involved.

### 3. Hosting and network

Whoever runs the machine and whatever sits in front of it (reverse proxy, CDN,
cloud provider) can see request metadata including IP addresses, and has access
to the disks holding the database and the images. That makes the hosting
provider a processor even though the application never deliberately sends them
anything.

If you put a CDN or WAF in front of the app, it terminates TLS and sees every
request and response — treat it as a processor too.

### 4. Image classification (`lib/nsfw/`)

Only when `NSFW_MODE=external`. The configured `NSFW_API_URL` receives the
re-encoded WebP bytes of every upload — the same bytes object storage gets,
never the original file — and `NSFW_API_KEY` authenticates the request. That
makes the named service an Art. 28 processor, same as the SMTP or S3 case
above: name it in `LEGAL_CLASSIFIER_PROCESSOR` before going live.

`off` (the default) skips classification entirely, and `local` runs an ONNX
model in the app process (`NSFW_MODEL_PATH`) — in both cases the image never
leaves for this purpose, regardless of where object storage or mail happen to
be.

## What deliberately does *not* leave the instance

Worth writing down, because these are the ones an auditor asks about and a
future contributor might unknowingly break:

- **No analytics, no external fonts, no CDN assets.** The pages reference no
  third-party host at all; everything is served from the instance.
- **Next.js telemetry is off.** `NEXT_TELEMETRY_DISABLED=1` is set in all three
  Dockerfile stages, so no build or usage data goes to Vercel.
- **Reporter IP addresses are never stored raw and never sent anywhere.**
  `lib/report-ip.ts` keeps a keyed hash for rate limiting only, and resolving a
  report deletes it (`lib/reports-server.ts`).
- **Solve progress stays in the browser.** It is kept in `localStorage` and
  never reaches the server.

## What each operator has to settle

For every external service in the table below:

1. **Name it.** Provider, and what they actually receive — use the flows above,
   not a guess.
2. **Get the DPA**, or record that the component is self-hosted and therefore
   not a processor. Most providers publish a standard Art. 28 agreement you
   accept in their console; keep a copy or a link with the date.
3. **Check where the data goes.** If the provider or its sub-processors are
   outside the EU/EEA, record the transfer basis (adequacy decision, standard
   contractual clauses) — and note that a US provider with EU regions still
   needs this, since support access is what matters, not where the bytes sit.
4. **Check the sub-processor list.** Your provider's own processors become yours;
   most publish a page and a change-notification policy.

### Template

This table stays empty in the repository, and that is not an oversight. Which
SMTP provider, which S3-compatible store and which hosting location an instance
uses is a deployment decision — two installations of this app can answer every
row differently, and the repo has no way to know. It is a template: copy it into
wherever you keep your own processing records, and fill it in there.

| Component | Self-hosted or provider | What they receive | DPA | Location / transfer basis |
| --- | --- | --- | --- | --- |
| SMTP (`SMTP_HOST`) | | | | |
| Object storage (`S3_ENDPOINT`) | | | | |
| Image classifier (`NSFW_API_URL`), only when `NSFW_MODE=external` | | the re-encoded WebP of every upload | | |
| Hosting / server | | | | |
| Reverse proxy or CDN, if any | | | | |

What the deployment *does* declare in the repo's own terms are the four
environment variables below — they are the published summary of the filled-in
table, not a substitute for it.

## How this reaches the privacy policy

The policy at `/legal/privacy` does not hardcode any of this. It renders from
the environment (`lib/legal.ts`, `app/[locale]/legal/privacy/page.tsx`):

- `LEGAL_MAIL_PROCESSOR` — set it to the provider's name and the policy says
  mail is handled by that named Art. 28 processor. **Left empty, the policy
  states that mail runs on a self-operated server and the address reaches no
  third party.** That is a factual claim; leaving the variable empty while using
  an external provider publishes a false statement.
- `LEGAL_STORAGE_PROCESSOR` — the same, for uploaded images.
- `LEGAL_CLASSIFIER_PROCESSOR` — set it when `NSFW_MODE=external`: the policy
  then adds a paragraph naming the classification service as a processor too.
  Unlike the two above, leaving it empty makes no claim at all — `off` and
  `local` never send the image anywhere, so there is no "self-hosted"
  statement to get wrong, and the paragraph is simply not shown.
- `LEGAL_HOSTING_REGION` — printed as-is ("Deutschland", "the EU"). Empty, the
  policy says the location is not stated rather than claiming the EU.

So the table above is the source and these four variables are its published
form. They must agree.

### What this means for installing

Nothing here is a build input, and the table is not an installation step. The
published images work as they are:

- **The four variables are read per request**, not baked in. `lib/legal.ts`
  reads `process.env` on every call and both legal pages are `force-dynamic`,
  so changing a value takes a container restart — `docker compose up -d` after
  editing `.env` — and never a rebuild. Verified by running one build twice
  with different values: the named provider, the storage provider and the
  hosting region all changed with the same `.next` artifacts. (The `●` marker
  `next build` prints for the legal routes is about `generateStaticParams` for
  the locale segment; the pages still render per request.)
- **Nothing legal is inside the image.** The Dockerfile declares no `LEGAL_*`
  build argument, and `.env` is in `.dockerignore`, so it is never copied in.
- **The table lives outside the deployment entirely.** No code reads it. It is
  your Art. 30 paperwork, not configuration, and can be written after the
  containers are up.

What *cannot* wait is knowing the answers. From the first minute the instance
is publicly reachable, `/legal/privacy` states either self-operation or a named
processor — so pointing `SMTP_HOST` or `S3_ENDPOINT` at an external service
while the matching `LEGAL_*` variable is empty publishes a false claim
immediately. Nothing cross-checks the two; that is on the operator.

**One exception to "everything is environment":** the database provider is
baked. `Dockerfile` takes `ARG DATABASE_PROVIDER=postgresql` and the generated
Prisma client must match it at runtime, so switching between PostgreSQL and
SQLite needs a differently built image, not a different variable —
`docker-compose.sqlite.yml` builds its own for that reason.

The policy's recipients section names all four message types and says that the
two notice mails also carry a puzzle title, so it matches the flows above
without an operator having to edit anything. Keep it that way: a new kind of
transactional mail, or an existing one that starts carrying more, needs that
paragraph updated in all three catalogs — nothing enforces the match.

## When adding a service

Anything new that sees personal data — an NSFW classifier as an external API
(#23), an error tracker, a queue, a backup target — needs the same treatment
before it ships: add the flow to this file, add the row, get the agreement, and
check whether the privacy policy needs a new sentence or a new environment
variable to name it.
