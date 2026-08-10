# NSFW classification on upload — design

Issue: #23 (the last open sub-issue of #2). Branch: `feat/23-nsfw-classification`.

Despite its name, `lib/moderation.ts` does nothing but enforce email bans. No
uploaded image is inspected at all. #22 already shipped the reactive half —
anyone can report a puzzle, an admin can take it down. This adds the proactive
half: an image is judged before it becomes a public puzzle.

## Decisions made during brainstorming

- **Three modes, `off` by default.** `NSFW_MODE` is `off` | `local` |
  `external`. `off` is a full member, not a degraded state: an existing
  instance that takes this update keeps publishing exactly as before — no model
  in memory, no request leaving the instance, nothing held for review — until
  an operator switches it on. The operator who wants no classifier at all is a
  supported operator, not an oversight.

  *Amended during implementation:* this bullet originally also promised "no new
  row written". `off` does write one `ImageVerdict` per upload
  (`CLEAN`/`0`/`model: "off"`), and the privacy policy says so. One uniform
  path is simpler, and the row is load-bearing: `model: "off"` is what
  distinguishes "judged by a disabled classifier" from "never judged at all",
  which is the distinction the missing-verdict rule below rests on.
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

### The local model: spike result

`local` ships. Package: **`onnxruntime-web@1.27.0`**, not `onnxruntime-node` —
the spike's first candidate failed criterion 4 (below), and the fallback that
passed all four is what `lib/nsfw/local.ts` (Task 9) is built on.

**Model:** `OwenElliott/image-safety-classifier-xs`, file
`onnx/image-safety-classifier-xs.onnx`, downloaded from
`https://huggingface.co/OwenElliott/image-safety-classifier-xs` at commit
`54f4560bd9c5ee92d45dc30418a8f8680e80de6d`. MIT licence (HF `cardData.license:
mit`, restated in the model card). 13,137,569 bytes (12.5 MiB, `du -h` reports
`13M`) — sha256
`8c28c49d9075f3ad15ebdc2961f02d5b3f99be944815b848b49c9f0e6f3fb689`. A larger
sibling (`image-safety-classifier-s`, 23.7 MB) exists but is too close to the
~25 MB bound to be the safe default.

**Inference contract for Task 9** (`createLocalClassifier(config, run)`, where
`run: (bytes: Buffer) => Promise<number>`):

- Import: **`import * as ort from "onnxruntime-web";`** — this repo is
  ESM/TypeScript (`tsconfig.json`: `"module": "esnext"`; `require()` appears
  in no `.ts` file here), so this is the form Task 9 actually writes, and it
  is the form that was verified against the real build — not `require()` in a
  scratch `node -e`, which is a different resolution path and does not prove
  anything about how Next bundles the route handler.
- **Required `next.config.ts` change, to be made in Task 9, not here:**
  add `"onnxruntime-web"` to the existing `serverExternalPackages` array, next
  to `"sharp"`:

  ```ts
  serverExternalPackages: ["sharp", "onnxruntime-web"],
  ```

  Without it, `npm run build` succeeds and compiles cleanly with no warning —
  the failure is silent until the route actually runs. Webpack resolves the
  bare `import` correctly to the package's `dist/ort.node.min.mjs` bundle (the
  `"node"` condition in its `exports` map is honoured for a server route), but
  that bundle loads its WASM backend via a companion file
  (`ort-wasm-simd-threaded.mjs`) at a path computed relative to itself at
  runtime, and webpack's bundling moves/renames files so that relative lookup
  breaks. Verified by building and running the actual production server
  (`next build` + `next start`) against a route that does
  `ort.InferenceSession.create(modelPath)`: it failed with
  `Cannot find module '.../route/ort-wasm-simd-threaded.mjs'` without the
  config change, and succeeded (`session ok, inputs=image
  outputs=probabilities`) with it — same code, same build, only the
  `next.config.ts` line changed. Full transcript in the fix-report addendum to
  `task-1-report.md`. This is the same class of fix `serverExternalPackages:
  ["sharp"]` already exists for, and for the same underlying reason: a
  package that resolves its own assets by relative path at runtime cannot be
  safely bundled.
- Once external, `ort.InferenceSession.create(pathToModel)` — a plain
  filesystem path, no manual buffer plumbing — works, confirmed by the same
  test above.
- Input tensor: name `"image"`, dtype `float32`, shape `[1, 3, 224, 224]`
  (NCHW). Decode with the project's existing `sharp` dependency: `.resize(224,
  224, { fit: "fill" }).removeAlpha().raw()` gives interleaved HWC `uint8`
  RGB; convert to planar CHW `Float32Array` with raw `0–255` values —
  **no mean/std normalisation, no /255 scaling**. The model card states
  normalisation is baked into the ONNX graph itself, and this was confirmed
  empirically: raw 0–255 input through this exact pipeline produces a
  correctly-behaved, already-soft-maxed output (see below).
- Output tensor: name `"probabilities"`, shape `[1, 3]`, already
  soft-maxed (sums to 1.0). Class order is fixed: **index 0 = NSFL** (gore/
  violent), **index 1 = NSFW** (pornographic/suggestive), **index 2 = SFW** —
  this is not read off the model's behaviour, it is stated directly by the
  model's own `config.json` at the pinned commit
  (`pretrained_cfg.label_names: ["NSFL", "NSFW", "SFW"]`; command and full
  output in the fix-report addendum to `task-1-report.md`). `run()` returns
  `probabilities.data[1]` — the NSFW index — as the explicit score
  `verdict.ts` thresholds against. NSFL is not surfaced; a future issue could
  route it separately, but nothing here reads index 0.
- Verified end-to-end (decode → resize → tensor → inference) with a synthetic
  solid-colour JPEG through this exact pipeline; output summed to 1.0 and
  matched a plain `onnxruntime-node` run of the same model bit-for-bit at ~1e-7
  float precision, so the WASM backend is not a numerical downgrade.

**How the file reaches the image:** not committed to git. `node:22-alpine`
already carries busybox `wget` (used today by the compose healthcheck), so a
`RUN wget -O` step in the `deps` or `build` stage of the Dockerfile can fetch
the pinned HF commit URL at build time and `COPY --from=build` it forward to
`runner`, the same pattern already used for `node_modules` and `.next`. Task 9
should pin the exact commit above and verify the sha256 after download, so a
model swap upstream can't silently change what ships. This wiring itself is
Task 9's job, not this spike's.

**Acceptance criteria — evidence (full commands and output in
`.superpowers/sdd/2026-08-09-nsfw-classification/task-1-report.md`):**

1. **PASS.** `onnxruntime-web` installs via plain `npm install` with zero
   lifecycle scripts run and zero native `.node` addons anywhere in its
   dependency tree (`flatbuffers`, `guid-typescript`, `long`,
   `onnxruntime-common`, `platform`, `protobufjs` — all pure JS). `npm audit`:
   0 vulnerabilities.
2. **PASS.** Model file is 13,137,569 bytes, well under 25 MB.
3. **PASS.** MIT for both the npm package and the model.
4. **PASS, but not with the obvious candidate.** `onnxruntime-node`'s prebuilt
   Linux x64 binary fails to load on the project's actual base image
   (`node:22-alpine`): `Error relocating
   .../libonnxruntime.so.1: __vsnprintf_chk: symbol not found` — a musl/glibc
   ABI mismatch that persists even with `gcompat` installed (tested and still
   fails; not that it would count anyway, since installing it would itself add
   a system package). `onnxruntime-web`'s WASM backend has no such dependency:
   built and ran, both `require("onnxruntime-web")` and a full decode-through-
   inference pass, inside a container built from the project's exact base
   layer (`node:22-alpine` + `apk add libc6-compat openssl`, nothing more) —
   no new base image, no new system package.

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

- `CLEAN`: `isPublic: true`, nothing else happens.
- **No verdict row at all:** what that means depends on whether any puzzle
  already references the key — the same read that rejects a key owned by
  someone else answers this, so it costs no extra query.
  - *Referenced:* an image uploaded before this feature, which is always
    already attached to the puzzle it was uploaded for. Treated as `CLEAN`.
  - *Unreferenced:* the verdict was swept as an orphan (see Cleanup) or its
    write failed after `putObject`. Nothing deletes the stored object in
    either case, so reading this as clean would let a flagged upload be
    laundered — never claim the key, wait out the grace period, then create
    the puzzle. Treated as `UNKNOWN`, i.e. held for review.
  - Both cases stay `CLEAN` when `NSFW_MODE` is `off`: nothing is judged
    there, so holding would hold everything.
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
successful `putObject` is logged and the upload still succeeds — the
alternative is failing an upload whose bytes are already stored. It is not a
hole: the key is unreferenced at that moment, so `/api/puzzles` holds the
puzzle for review when it is claimed (unless the mode is `off`).

## Cleanup

An upload the user abandons leaves a verdict with no puzzle. `lib/retention.ts`
gains one step: delete `ImageVerdict` rows older than the grace period whose
`imageKey` no `Puzzle` references. It rides the existing opportunistic sweep
and its throttle, and is reported by `/api/health/ready` like the others.

The grace period is a week, not the day originally planned. Since a key whose
verdict has vanished is now *held* rather than published, sweeping early has a
cost — a user who uploads and submits the create form days later would land in
the moderation queue. The rows are tiny and only orphans are swept, so the
generous window is free.

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
  puzzle and no report; a missing verdict row behaves like clean when a puzzle
  already references the key, and is held when none does (except in `off`).
- Retention step — a verdict with no puzzle and past the grace period is
  deleted, one with a puzzle is kept, and a young orphan is kept.
- The two together — a verdict exists, the sweep deletes it as an orphan, the
  key is then claimed: the puzzle must be held and a report filed. Each half is
  correct alone, which is exactly why the combination needs its own test.
- Local preprocessing — the tensor name, dtype and `[1, 3, 224, 224]` shape,
  the HWC→CHW transposition, RGB plane order, raw 0-255 values (no `/255`, no
  mean/std), and that the score read is the NSFW class index.

## Deliberately not in scope

- No re-classification of images uploaded before this feature.
- No user-facing appeal flow. The admin takedown queue from #22 is the recourse.
- No score or verdict shown anywhere in the UI.
- No automatic deletion. Only a human deletes content.
- No per-user or per-instance threshold tuning UI — env only.
