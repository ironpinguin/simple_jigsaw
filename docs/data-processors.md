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

#### The endpoint contract

`external` speaks a deliberately small HTTP contract of this repo's own, so that
what a processor receives is exactly one thing and easy to state in the Art. 30
record. Per upload, `lib/nsfw/external.ts` sends:

```http
POST <NSFW_API_URL>
Authorization: Bearer <NSFW_API_KEY>
Content-Type: image/webp

<the re-encoded WebP bytes, as the raw body — no multipart, no JSON envelope>
```

and expects, on `200`:

```json
{ "score": 0.07 }
```

`score` is the probability that the image is unsafe, `0..1`, compared against
`NSFW_THRESHOLD`. Nothing else in the body is read, so a service may return more
fields. Anything that is not a usable answer — a non-2xx status, a missing or
non-numeric `score`, a number outside `0..1` — is treated as a classifier
failure: it is logged, the verdict becomes `UNKNOWN`, and the puzzle is held for
review rather than published. The request carries its own timeout
(`NSFW_TIMEOUT_MS`), and a timeout is handled the same way.

**This is not any vendor's API.** Commercial moderation services take their own
request shapes — multipart, base64, or a reference to an object you upload first
— authenticate their own way, and answer with a set of per-category labels
rather than one number. Pointing `NSFW_API_URL` straight at one will produce a
non-2xx or an unreadable body, which fails closed: every upload held, nothing
published. Two workable shapes:

- **Your own inference endpoint**, which is what the contract is sized for — the
  same ONNX model `local` uses, or a larger one, behind whatever runtime you
  like. Nothing leaves your infrastructure and no Art. 28 processor is involved,
  so `LEGAL_CLASSIFIER_PROCESSOR` stays empty.
- **A thin adapter in front of a commercial service**, translating this contract
  into theirs and collapsing their label set into one `score`. The processor you
  name in `LEGAL_CLASSIFIER_PROCESSOR` is then the *upstream service*, not your
  adapter, because that is who actually receives the image.

#### What to look for in a service

The market calls this **image moderation**, **visual content moderation** or
**NSFW/explicit content detection**; for something you host yourself, search for
an **NSFW image classifier** with **ONNX** or **TorchServe** weights. Once you
have candidates, the questions that decide whether one fits *this* deployment:

**Does it fit the contract and the request cycle?**

- **A numeric confidence, not just a verdict.** The adapter needs a `0..1`
  number to hand over, and `NSFW_THRESHOLD` is only a useful knob if there is a
  score behind it. A service that answers `SAFE` / `UNSAFE` and nothing else
  can be mapped to `0`/`1`, but the threshold stops meaning anything.
- **Synchronous, one request, fast.** The call sits inside the user's upload,
  bounded by `NSFW_TIMEOUT_MS` (default 5 s). Queue-and-poll or webhook-callback
  APIs do not fit without holding the upload open, and every timeout is a held
  puzzle.
- **Categories that match what you are moderating.** `local` scores gore *and*
  explicit content, so a service that only detects nudity narrows what the
  instance catches when an operator switches modes. Pick which categories your
  adapter folds into the score deliberately, and write it down.
- **Accepts the bytes directly, and accepts WebP.** Uploads are re-encoded to
  WebP before classification. Services that require JPEG/PNG, base64, or a URL
  they fetch themselves all mean more work in the adapter — and the URL variant
  means making the image publicly reachable, which for an image that has not
  been cleared yet is the wrong direction entirely.

**Does it survive the data-protection questions?** These are the ones that
actually take time, so ask them before benchmarking accuracy:

- **An Art. 28 DPA it will actually sign.** You are sending user-uploaded
  photographs to a third party. No contract, no `external` mode.
- **Where processing happens**, and for a non-EU/EEA provider, which transfer
  mechanism applies (adequacy decision, or SCCs plus a transfer impact
  assessment). This is also what `LEGAL_HOSTING_REGION` and the policy have to
  stay consistent with.
- **No retention and no training on your images**, contractually, not in a blog
  post. The privacy policy this repo renders says images are sent *to check for
  explicit content* — a provider that keeps them for model improvement makes
  that statement incomplete.
- **A published subprocessor list**, since their subprocessors become yours to
  disclose.

**Operationally**, check per-image pricing and rate limits against your upload
volume — note `/api/upload` is not rate-limited yet, so a burst is a bill — and
remember that an outage is not a silent failure here: every upload is held for
review until the service answers again.

**The alternative that skips all of the above** is running the classification
yourself, either as `local` or as your own endpoint behind `external`. Then
there is no Art. 28 relationship, `LEGAL_CLASSIFIER_PROCESSOR` stays empty, and
the privacy policy keeps its stronger claim that images reach no third party.
That is the default this repo is built around; `external` exists for operators
who have a reason to prefer someone else's classifier.

A minimal compatible endpoint is about as long as its own error handling:

```js
// POST /classify — Express; reads the raw body, answers one number.
app.post("/classify", express.raw({ type: "image/webp", limit: "15mb" }), async (req, res) => {
  if (req.get("authorization") !== `Bearer ${process.env.SHARED_KEY}`) {
    return res.sendStatus(401);
  }
  try {
    res.json({ score: await scoreTheImage(req.body) }); // 0..1
  } catch {
    // 500 rather than a guessed score: the caller holds the image for review,
    // which is the safe direction. Answering 0 would publish it.
    res.sendStatus(500);
  }
});
```

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
processor — so pointing `SMTP_HOST`, `S3_ENDPOINT` or `NSFW_API_URL` (with
`NSFW_MODE=external`) at an external service while the matching `LEGAL_*`
variable is empty publishes a false claim immediately. Nothing cross-checks
the two; that is on the operator — though `readNsfwConfig`
(`lib/nsfw/config.ts`) does log a warning when `NSFW_MODE=external` is set
without a matching `LEGAL_CLASSIFIER_PROCESSOR`. It warns and nothing more:
classification still runs, only the disclosure is missing, which is a legal
problem rather than a functional one. That is the opposite of a missing
`NSFW_API_URL`/`NSFW_API_KEY`, which also warns but leaves the classifier
unable to run, so uploads are held for review instead of being published
unchecked.

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
