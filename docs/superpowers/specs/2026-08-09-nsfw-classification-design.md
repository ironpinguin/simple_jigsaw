# NSFW classification on upload — design

Issue: #23 (the last open sub-issue of #2). Branch: `feat/23-nsfw-classification`.

Despite its name, `lib/moderation.ts` does nothing but enforce email bans. No
uploaded image is inspected at all. #22 already shipped the reactive half —
anyone can report a puzzle, an admin can take it down. This adds the proactive
half: an image is judged before it becomes a public puzzle.

## Decisions made during brainstorming

- **Three modes, `off` by default.** `NSFW_MODE` is `off` | `local` |
  `external`. `off` is a full member, not a degraded state: an existing
  instance that takes this update behaves exactly as before — no model in
  memory, no new row written — until an operator switches it on. The operator
  who wants no classifier at all is a supported operator, not an oversight.
- **A hit is accepted, not rejected.** The puzzle is created private and queued
  for review instead of the upload being refused. A wrongly flagged holiday
  photo is then one admin click from being public, rather than gone with no
  recourse — the "bad outcome" the issue names. It also reuses #22's queue
  whole, rather than inventing a second moderation surface.
- **A classifier failure is treated as a hit.** Timeout, model load failure and
  a 500 from an external service all produce `UNKNOWN`, which takes the same
  path as `FLAGGED`. Uploads keep working when the classifier is broken, but
  nothing passes unexamined — the issue's explicit requirement that an
  exception must not silently wave content through. Fail-open-and-log was
  rejected because a permanently broken classifier is then indistinguishable
  from a clean instance; fail-closed was rejected because a model fault would
  stop all uploading for an *optional* feature.
- **The uploader is told, neutrally.** A translated note says the puzzle is
  private for now and awaiting review. No score, no "NSFW detected" — against a
  false positive that is an accusation, and it tells anyone probing the system
  where the threshold sits. Silence was rejected because the user reads it as a
  bug and re-uploads, flooding the queue with duplicates.
- **The verdict travels in its own table, keyed by `imageKey`.** Not through
  the client, which could otherwise acquit itself.

## Current state

Verified, not assumed:

- `app/api/upload/route.ts` re-encodes with sharp (`.rotate().resize(2000,
  inside).webp({quality: 82})`), then `putObject`, then returns `{ imageKey,
  width, height }`. Nothing inspects the pixels.
- `app/api/puzzles/route.ts` is a **separate request** and is where `isPublic`
  is set. This is the structural fact the issue does not mention: classification
  happens in one request, the consequence lands in another.
- `Report` (`prisma/schema.prisma`) deliberately has no relation to `Puzzle`, so
  a report survives the takedown. `status` and `category` are plain strings with
  a schema comment stating that a new value is a code change needing no
  migration — `lib/reports.ts` holds the allowed values.
- `lib/retention.ts` already runs an opportunistic sweep with a `globalThis`
  throttle, and `/api/health/ready` reports on it.
- `docs/data-processors.md` has a section titled "What deliberately does *not*
  leave the instance". Uploaded images are currently in it.

## Components

### Verdict logic — `lib/nsfw/verdict.ts`

Pure, no I/O, no model. This is where the threshold lives, so it is testable
without a runtime.

```ts
export type VerdictLabel = "CLEAN" | "FLAGGED" | "UNKNOWN";
export type Verdict = { label: VerdictLabel; score: number; model: string };

export function labelFor(score: number, threshold: number): VerdictLabel;
export function toVerdictLabel(value: string): VerdictLabel | null;
export function requiresReview(label: VerdictLabel): boolean;  // FLAGGED | UNKNOWN
```

`toVerdictLabel` is the one boundary that validates the string column, the way
`lib/roles.ts` and `lib/reports.ts` do it for SQLite's missing enums.

### Classifier selection — `lib/nsfw/index.ts`

```ts
export interface Classifier { classify(bytes: Buffer): Promise<Verdict> }
export function getClassifier(): Classifier;   // reads NSFW_MODE once per process
```

Three implementations behind it:

- `lib/nsfw/off.ts` — returns `{ label: "CLEAN", score: 0, model: "off" }`
  without touching the bytes. No timeout, no log line, no cost.
- `lib/nsfw/local.ts` — wraps the on-device runtime. Loads the model once and
  reuses it, so only the first upload after a start pays for loading.
- `lib/nsfw/external.ts` — one HTTP POST to `NSFW_API_URL` with
  `NSFW_API_KEY`. Sends the re-encoded WebP, never the original.

Both active implementations are wrapped by one shared guard that applies
`NSFW_TIMEOUT_MS` and converts every throw into `UNKNOWN` with a
`console.error`. Neither implementation needs its own error handling, and the
failure policy exists in exactly one place.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `NSFW_MODE` | `off` | `off` \| `local` \| `external` |
| `NSFW_THRESHOLD` | `0.85` | score at or above which an image is `FLAGGED` |
| `NSFW_TIMEOUT_MS` | `5000` | budget for one classification |
| `NSFW_API_URL` | — | required when mode is `external` |
| `NSFW_API_KEY` | — | required when mode is `external` |

An unknown `NSFW_MODE`, or `external` without URL and key, is a startup
misconfiguration: log once and fall back to `off`. An operator who mistypes the
mode gets today's behaviour and a log line, not a broken upload path.

### The local model

The one thing brainstorming could not settle from the repo alone. It is
resolved by a decision rule rather than left open:

Step one of the implementation plan is a spike against fixed criteria — pure
npm install with no project-level build step (`onnxruntime-node` prebuilds
qualify, `@tensorflow/tfjs-node` does not, because of its native build),
model under ~25 MB, permissive licence, and it must run inside the existing
Docker image without a new base layer.

If nothing meets the criteria, `local` is dropped from this issue and shipped
as its own ticket; `off` and `external` deliver on their own and the interface
above is unchanged. This is a decision the spike makes on evidence, not a
question deferred indefinitely.

### Data model

```prisma
model ImageVerdict {
  imageKey  String   @id
  label     String   // "CLEAN" | "FLAGGED" | "UNKNOWN", validated in lib/nsfw/verdict.ts
  score     Float
  model     String   // which model or service judged it, for later re-checks
  createdAt DateTime @default(now())
}
```

Strings rather than Prisma enums, because SQLite has none — the same shape as
`Role`, `Report.status` and `Report.category`. Applied with `npm run db:push`
on both providers via `scripts/prisma.mjs`.

`imageKey` is the primary key: one image, one verdict. Note the existing
`Puzzle.imageKey` is deliberately *not* unique (a key may be reused across an
owner's puzzles), so several puzzles can share one verdict — which is correct,
since it is a property of the bytes.

## Data flow

**`POST /api/upload`** — after the sharp re-encode, before `putObject`:

1. `classify(output)` on the re-encoded WebP, so exactly the stored bytes are
   judged. This is the issue's requirement and the reason classification does
   not sit in `/api/puzzles`.
2. `putObject` as today.
3. Write `ImageVerdict`. If `putObject` fails, no verdict is written and the
   request fails as it does today.
4. Respond `{ imageKey, width, height }`, unchanged. The verdict is not sent to
   the client, in any mode.

**`POST /api/puzzles`** — reads the verdict for the submitted `imageKey`:

- `CLEAN`, or no verdict row at all (an image uploaded before this feature, or
  in `off` mode): `isPublic: true`, nothing else happens.
- `FLAGGED` or `UNKNOWN`: `isPublic: false`, plus one `Report` row —
  `category: "AUTO_NSFW"`, `status: "OPEN"`, `reporterEmail: null`,
  `reporterIpHash: null`, `message` carrying the score and model. The response
  carries a flag so the client can show the note.

`AUTO_NSFW` is a new value in `lib/reports.ts`, not a schema change. The queue
from #22 lists it and takedown works on it unchanged; the null reporter fields
are what distinguish a machine's judgement from a person's in the UI.

## Error handling

Every failure mode of the classifier — timeout, model load, HTTP error, an
unparseable response — produces `UNKNOWN`, logged with `console.error`, and
`UNKNOWN` takes the `FLAGGED` path. The size bound is already there:
`MAX_BYTES` caps the input at 15 MB and `MAX_EDGE` downscales to 2000 px, and
classification runs on the downscaled WebP.

A `putObject` failure leaves no verdict row. A verdict write failure after a
successful `putObject` is logged and the upload still succeeds — `/api/puzzles`
then sees no row and treats it as `CLEAN`, the same as any pre-existing image.
That is a deliberate narrow hole: the alternative is failing an upload whose
bytes are already stored.

## Cleanup

An upload the user abandons leaves a verdict with no puzzle. `lib/retention.ts`
gains one step: delete `ImageVerdict` rows older than 24 hours whose `imageKey`
no `Puzzle` references. It rides the existing opportunistic sweep and its
throttle, and is reported by `/api/health/ready` like the others.

## Text and documentation

- New note after puzzle creation in DE, EN and IT: the puzzle is private for
  now and will be reviewed. Neutral wording, no score, no accusation.
- `docs/data-processors.md`: uploaded images may no longer be listed flatly
  under "does not leave the instance". The `external` mode gets its own
  subsection and a row in the operator table; `off` and `local` keep the
  current statement.
- The privacy policy from #16 gets the matching paragraph, conditioned on mode.
- `CHANGELOG.md`: one bullet under `### Added` naming the default as `off`.

## Testing

No test touches a real model or the network.

- `lib/nsfw/verdict.ts` — thresholds and boundaries, including exactly at the
  threshold, and `toVerdictLabel` rejecting an unknown string.
- Mode selection — `off` returns `CLEAN` without reading the bytes; an unknown
  mode and an `external` without credentials both fall back to `off` and log.
- The shared guard — a classifier that hangs past the timeout yields `UNKNOWN`;
  one that throws yields `UNKNOWN`; both log.
- Upload route with an injected fake — clean, flagged and timeout paths, and
  the assertion that the response body never carries the verdict.
- Puzzles route — flagged verdict produces `isPublic: false` and exactly one
  `AUTO_NSFW` report with null reporter fields; clean verdict produces a public
  puzzle and no report; a missing verdict row behaves like clean.
- Retention step — a verdict with no puzzle and older than 24 h is deleted, one
  with a puzzle is kept, and a young orphan is kept.

## Deliberately not in scope

- No re-classification of images uploaded before this feature.
- No user-facing appeal flow. The admin takedown queue from #22 is the recourse.
- No score or verdict shown anywhere in the UI.
- No automatic deletion. Only a human deletes content.
- No per-user or per-instance threshold tuning UI — env only.
