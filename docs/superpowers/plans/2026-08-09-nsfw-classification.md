# NSFW Classification on Upload — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Judge an uploaded image before it becomes a public puzzle — off by default, a hit is accepted but held private and queued for an admin.

**Architecture:** A pure verdict module decides `CLEAN`/`FLAGGED`/`UNKNOWN` from a score and a threshold. One `Classifier` interface has three implementations (`off`, `local`, `external`) selected by env, all wrapped in a single guard that applies the timeout and turns any throw into `UNKNOWN`. `POST /api/upload` classifies the re-encoded WebP and stores the verdict in `ImageVerdict`, keyed by `imageKey`; `POST /api/puzzles` reads it and, for `FLAGGED`/`UNKNOWN`, creates the puzzle private plus an `AUTO_NSFW` report in the existing #22 queue.

**Tech Stack:** Next.js App Router, TypeScript, Prisma (Postgres + SQLite), Vitest, next-intl, sharp (already in the upload path).

Design: [`docs/superpowers/specs/2026-08-09-nsfw-classification-design.md`](../specs/2026-08-09-nsfw-classification-design.md). Issue: #23.

## Global Constraints

- Every user-facing string needs an entry in `messages/de.json`, `messages/en.json` **and** `messages/it.json`. DE is the default locale.
- `prisma/schema.prisma` is the single source; `scripts/prisma.mjs` rewrites only the datasource for SQLite. **No Prisma enums** — role/status/category columns are strings validated in code. Apply with `npm run db:push`.
- `lib/` stays free of React and, where the spec says "pure", free of I/O — so it stays unit-testable.
- Quality gates before any PR: `npm run lint`, `npm test`, `npm run build`. Semgrep runs in CI.
- Every user-facing change gets a bullet under `## [Unreleased]` in `CHANGELOG.md`.
- **No test may load a real model or touch the network.** Classifiers are injected as fakes.
- Default behaviour with no configuration is exactly today's behaviour: `NSFW_MODE` unset ⇒ `off`.
- Exact env names and defaults: `NSFW_MODE` (`off`), `NSFW_THRESHOLD` (`0.85`), `NSFW_TIMEOUT_MS` (`5000`), `NSFW_API_URL` (unset), `NSFW_API_KEY` (unset).

---

### Task 1: Spike — choose the local runtime and model

This task is a **gate**, not a feature. Its output is a decision with evidence. Tasks 2–8 and 10–12 do not depend on its outcome; only Task 9 (`local.ts`) does.

**Files:**
- Create: `docs/superpowers/specs/2026-08-09-nsfw-classification-design.md` — append a "Local model: spike result" section
- Scratch work goes in a throwaway directory outside the repo, never committed

**Interfaces:**
- Consumes: nothing
- Produces: a yes/no on `local`, and if yes: the package name, the model file, its size, its licence, and how the model reaches the Docker image

**Acceptance criteria — all four must hold, no exceptions:**
1. Installs via plain `npm install` with no project-level native build step. `onnxruntime-node` prebuilt binaries qualify. `@tensorflow/tfjs-node` does **not** — it compiles on install.
2. Model file under ~25 MB.
3. Permissive licence (MIT / Apache-2.0 / BSD), compatible with redistribution in a Docker image.
4. Runs in the existing image without adding a base layer or a system package.

- [ ] **Step 1: Try the candidate in a scratch directory**

```bash
mkdir -p /tmp/nsfw-spike && cd /tmp/nsfw-spike && npm init -y
npm install onnxruntime-node
# Fetch the candidate ONNX model into this directory, then:
node -e "
const ort = require('onnxruntime-node');
ort.InferenceSession.create('./model.onnx').then(s => {
  console.log('inputs', s.inputNames, 'outputs', s.outputNames);
}).catch(e => { console.error('FAILED', e); process.exit(1); });
"
```

- [ ] **Step 2: Measure against the criteria**

```bash
du -h /tmp/nsfw-spike/model.onnx          # criterion 2: under ~25 MB
npm ls --all 2>/dev/null | grep -i "gyp\|node-pre-gyp" || echo "no native build"   # criterion 1
```

Record the model's licence from its source page. Criterion 4 is checked by building the image in Step 3.

- [ ] **Step 3: Confirm it runs in the project image**

```bash
docker compose build app && docker compose run --rm app node -e "require('onnxruntime-node'); console.log('ok')"
```
Expected: prints `ok`. A failure here fails criterion 4.

- [ ] **Step 4: Record the decision in the spec**

Append to the design doc, replacing the "The local model" section's decision rule with the outcome. State the package, model, size, licence and how the file gets into the image — or, if a criterion failed, state which one and that `local` moves to its own issue.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-08-09-nsfw-classification-design.md
git commit -m "docs(nsfw): record the local model spike result (#23)"
```

**If the spike fails:** skip Task 9 entirely, drop `"local"` from the `NSFW_MODE` union in Task 3, and open a follow-up issue. Everything else in this plan ships unchanged.

---

### Task 2: Verdict logic — `lib/nsfw/verdict.ts`

Pure: no I/O, no model, no Prisma. This is where the threshold lives so it can be tested without a runtime.

**Files:**
- Create: `lib/nsfw/verdict.ts`
- Test: `lib/nsfw/verdict.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type VerdictLabel = "CLEAN" | "FLAGGED" | "UNKNOWN"`
  - `type Verdict = { label: VerdictLabel; score: number; model: string }`
  - `labelFor(score: number, threshold: number): VerdictLabel`
  - `toVerdictLabel(value: string): VerdictLabel | null`
  - `requiresReview(label: VerdictLabel): boolean`

- [ ] **Step 1: Write the failing tests**

```ts
// lib/nsfw/verdict.test.ts
import { describe, expect, it } from "vitest";
import { labelFor, requiresReview, toVerdictLabel } from "./verdict";

describe("labelFor", () => {
  it("calls a score below the threshold clean", () => {
    expect(labelFor(0.4, 0.85)).toBe("CLEAN");
  });

  it("flags a score above the threshold", () => {
    expect(labelFor(0.9, 0.85)).toBe("FLAGGED");
  });

  it("flags a score exactly at the threshold", () => {
    // The threshold is the point where review starts, not the point after it:
    // an off-by-one here is the difference between reviewing a borderline
    // image and publishing it.
    expect(labelFor(0.85, 0.85)).toBe("FLAGGED");
  });

  it("refuses a score outside 0..1 rather than guessing", () => {
    // A classifier returning a percentage instead of a probability would
    // otherwise read as permanently clean.
    expect(labelFor(-0.1, 0.85)).toBe("UNKNOWN");
    expect(labelFor(42, 0.85)).toBe("UNKNOWN");
    expect(labelFor(Number.NaN, 0.85)).toBe("UNKNOWN");
  });
});

describe("toVerdictLabel", () => {
  it("accepts the three stored values", () => {
    expect(toVerdictLabel("CLEAN")).toBe("CLEAN");
    expect(toVerdictLabel("FLAGGED")).toBe("FLAGGED");
    expect(toVerdictLabel("UNKNOWN")).toBe("UNKNOWN");
  });

  it("rejects anything else, so a bad column cannot reach a translation lookup", () => {
    expect(toVerdictLabel("clean")).toBeNull();
    expect(toVerdictLabel("")).toBeNull();
  });
});

describe("requiresReview", () => {
  it("holds back both a hit and an unusable answer", () => {
    expect(requiresReview("FLAGGED")).toBe(true);
    expect(requiresReview("UNKNOWN")).toBe(true);
  });

  it("lets a clean image through", () => {
    expect(requiresReview("CLEAN")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/nsfw/verdict.test.ts`
Expected: FAIL — `Failed to resolve import "./verdict"`.

- [ ] **Step 3: Write the minimal implementation**

```ts
// lib/nsfw/verdict.ts
// The classification decision, kept pure so the threshold can be tested
// without a model or a network. Same string-union shape as lib/roles.ts and
// lib/reports.ts, because the DB column is a plain string on both providers.

export const VERDICT_LABELS = ["CLEAN", "FLAGGED", "UNKNOWN"] as const;
export type VerdictLabel = (typeof VERDICT_LABELS)[number];

export type Verdict = {
  label: VerdictLabel;
  /** Probability in 0..1. Zero for `off`, which never looks at the bytes. */
  score: number;
  /** Which model or service judged it, so an old verdict can be re-checked. */
  model: string;
};

/**
 * A score at or above `threshold` is flagged — the threshold is where review
 * starts, not where it starts after. A score outside 0..1 (or NaN) is not a
 * probability at all, so it is `UNKNOWN` rather than quietly clean.
 */
export function labelFor(score: number, threshold: number): VerdictLabel {
  if (!Number.isFinite(score) || score < 0 || score > 1) return "UNKNOWN";
  return score >= threshold ? "FLAGGED" : "CLEAN";
}

/** DB → typed-value boundary, the one place a stored label is validated. */
export function toVerdictLabel(value: string): VerdictLabel | null {
  return (VERDICT_LABELS as readonly string[]).includes(value)
    ? (value as VerdictLabel)
    : null;
}

/** Whether this label must keep the puzzle private and open a report. */
export function requiresReview(label: VerdictLabel): boolean {
  return label !== "CLEAN";
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/nsfw/verdict.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/nsfw/verdict.ts lib/nsfw/verdict.test.ts
git commit -m "feat(nsfw): verdict labels and the review threshold (#23)"
```

---

### Task 3: Configuration, the off classifier and the failure guard

Do **not** create `lib/nsfw/index.ts` in this task — the selector is Task 3b, dispatched after Tasks 9 and 10 because it imports them statically. Creating it here would import modules that do not exist yet.

**Files:**
- Create: `lib/nsfw/config.ts`, `lib/nsfw/types.ts`, `lib/nsfw/off.ts`, `lib/nsfw/guard.ts`
- Test: `lib/nsfw/config.test.ts`, `lib/nsfw/guard.test.ts`

**Interfaces:**
- Consumes: `Verdict`, `VerdictLabel`, `labelFor` from Task 2
- Produces:
  - `interface Classifier { classify(bytes: Buffer): Promise<Verdict> }` (in `types.ts`)
  - `type NsfwConfig = { mode: "off" | "local" | "external"; threshold: number; timeoutMs: number; apiUrl: string | null; apiKey: string | null }`
  - `readNsfwConfig(env: NodeJS.ProcessEnv): NsfwConfig`
  - `NSFW_MODES`, `DEFAULT_THRESHOLD`, `DEFAULT_TIMEOUT_MS`
  - `guard(classifier: Classifier, timeoutMs: number): Classifier`
  - `offClassifier: Classifier`

- [ ] **Step 1: Write the failing config tests**

```ts
// lib/nsfw/config.test.ts
import { describe, expect, it, vi } from "vitest";
import { readNsfwConfig } from "./config";

describe("readNsfwConfig", () => {
  it("is off when nothing is set, so an existing instance is unchanged", () => {
    expect(readNsfwConfig({}).mode).toBe("off");
  });

  it("carries the defaults for threshold and timeout", () => {
    const config = readNsfwConfig({});
    expect(config.threshold).toBe(0.85);
    expect(config.timeoutMs).toBe(5000);
  });

  it("reads an explicit mode", () => {
    expect(readNsfwConfig({ NSFW_MODE: "local" }).mode).toBe("local");
  });

  it("falls back to off and warns on a mode it does not know", () => {
    // A typo must not break uploading for a feature that is optional.
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(readNsfwConfig({ NSFW_MODE: "locel" }).mode).toBe("off");
    expect(warned).toHaveBeenCalled();
    warned.mockRestore();
  });

  it("falls back to off and warns when external has no url or key", () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(readNsfwConfig({ NSFW_MODE: "external" }).mode).toBe("off");
    expect(
      readNsfwConfig({ NSFW_MODE: "external", NSFW_API_URL: "https://x.example" }).mode,
    ).toBe("off");
    expect(warned).toHaveBeenCalled();
    warned.mockRestore();
  });

  it("keeps external when both credentials are present", () => {
    const config = readNsfwConfig({
      NSFW_MODE: "external",
      NSFW_API_URL: "https://x.example/check",
      NSFW_API_KEY: "secret",
    });
    expect(config.mode).toBe("external");
    expect(config.apiUrl).toBe("https://x.example/check");
  });

  it("ignores an unusable threshold rather than classifying everything", () => {
    // NSFW_THRESHOLD=0 would flag every upload; a non-number would make the
    // comparison always false and flag nothing. Both fall back to the default.
    expect(readNsfwConfig({ NSFW_THRESHOLD: "banana" }).threshold).toBe(0.85);
    expect(readNsfwConfig({ NSFW_THRESHOLD: "0" }).threshold).toBe(0.85);
    expect(readNsfwConfig({ NSFW_THRESHOLD: "1.5" }).threshold).toBe(0.85);
    expect(readNsfwConfig({ NSFW_THRESHOLD: "0.6" }).threshold).toBe(0.6);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/nsfw/config.test.ts`
Expected: FAIL — `Failed to resolve import "./config"`.

- [ ] **Step 3: Write the config module**

```ts
// lib/nsfw/config.ts
// Reading the five NSFW_* variables, in one place, with one rule: a
// misconfiguration falls back to `off` and says so. This feature is optional,
// so a typo must leave uploading exactly as it is today rather than break it.

export const NSFW_MODES = ["off", "local", "external"] as const;
export type NsfwMode = (typeof NSFW_MODES)[number];

export const DEFAULT_THRESHOLD = 0.85;
export const DEFAULT_TIMEOUT_MS = 5000;

export type NsfwConfig = {
  mode: NsfwMode;
  threshold: number;
  timeoutMs: number;
  apiUrl: string | null;
  apiKey: string | null;
};

function positiveNumber(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 && value <= max ? value : fallback;
}

export function readNsfwConfig(env: NodeJS.ProcessEnv): NsfwConfig {
  const requested = env.NSFW_MODE ?? "off";
  const apiUrl = env.NSFW_API_URL ?? null;
  const apiKey = env.NSFW_API_KEY ?? null;

  let mode: NsfwMode = "off";
  if ((NSFW_MODES as readonly string[]).includes(requested)) {
    mode = requested as NsfwMode;
  } else {
    console.warn(`[nsfw] unknown NSFW_MODE "${requested}"; classification stays off`);
  }

  if (mode === "external" && !(apiUrl && apiKey)) {
    console.warn("[nsfw] NSFW_MODE=external needs NSFW_API_URL and NSFW_API_KEY; staying off");
    mode = "off";
  }

  return {
    mode,
    threshold: positiveNumber(env.NSFW_THRESHOLD, DEFAULT_THRESHOLD, 1),
    timeoutMs: positiveNumber(env.NSFW_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 60_000),
    apiUrl,
    apiKey,
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run lib/nsfw/config.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Write the failing guard tests**

```ts
// lib/nsfw/guard.test.ts
import { describe, expect, it, vi } from "vitest";
import { guard } from "./guard";
import type { Classifier } from "./types";

const bytes = Buffer.from("not really an image");

describe("guard", () => {
  it("passes a verdict straight through", async () => {
    const inner: Classifier = {
      classify: async () => ({ label: "CLEAN", score: 0.1, model: "fake" }),
    };

    await expect(guard(inner, 50).classify(bytes)).resolves.toEqual({
      label: "CLEAN",
      score: 0.1,
      model: "fake",
    });
  });

  it("turns a throw into UNKNOWN and logs it", async () => {
    // Nothing may pass unexamined: an exception that read as CLEAN would make
    // a broken classifier look exactly like a clean instance.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const inner: Classifier = {
      classify: async () => {
        throw new Error("model not loaded");
      },
    };

    const verdict = await guard(inner, 50).classify(bytes);

    expect(verdict.label).toBe("UNKNOWN");
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("gives up at the timeout instead of holding the upload open", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const inner: Classifier = {
      classify: () => new Promise(() => {}), // never settles
    };

    const verdict = await guard(inner, 20).classify(bytes);

    expect(verdict.label).toBe("UNKNOWN");
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run lib/nsfw/guard.test.ts`
Expected: FAIL — `Failed to resolve import "./guard"`.

- [ ] **Step 7: Write the types, the off classifier and the guard**

```ts
// lib/nsfw/types.ts
import type { Verdict } from "./verdict";

/** One image in, one verdict out. The only thing a mode has to implement. */
export interface Classifier {
  classify(bytes: Buffer): Promise<Verdict>;
}
```

```ts
// lib/nsfw/off.ts
import type { Classifier } from "./types";

// The supported way to run Jigsaw without classification: it never reads the
// bytes, never loads a model and costs nothing.
export const offClassifier: Classifier = {
  classify: async () => ({ label: "CLEAN", score: 0, model: "off" }),
};
```

```ts
// lib/nsfw/guard.ts
import type { Classifier } from "./types";

/**
 * The failure policy, in exactly one place: every mode is wrapped in this, so
 * `local.ts` and `external.ts` need no error handling of their own and cannot
 * drift apart on what a failure means.
 *
 * A timeout or a throw becomes UNKNOWN, which `requiresReview` treats like a
 * hit — the upload still succeeds, but the puzzle is held for review. Logged,
 * because a permanently broken classifier must not be indistinguishable from
 * a clean instance.
 */
export function guard(inner: Classifier, timeoutMs: number): Classifier {
  return {
    async classify(bytes) {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          inner.classify(bytes),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
          }),
        ]);
      } catch (error) {
        console.error("[nsfw] classification failed; holding the image for review:", error);
        return { label: "UNKNOWN", score: 0, model: "error" };
      } finally {
        // Or a 5s handle keeps the event loop busy after every fast upload.
        if (timer) clearTimeout(timer);
      }
    },
  };
}
```

- [ ] **Step 8: Run it to verify it passes**

Run: `npx vitest run lib/nsfw/guard.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 9: Run the whole nsfw suite and commit**

The selector that ties these together is **Task 3b**, which is dispatched after Tasks 9 and 10 because it imports them statically.

Run: `npx vitest run lib/nsfw/`
Expected: PASS — verdict, config and guard tests all green.

```bash
git add lib/nsfw/
git commit -m "feat(nsfw): mode configuration, the off classifier and the failure guard (#23)"
```

---

### Task 3b: The classifier selector — `lib/nsfw/index.ts`

**Execution order:** dispatch this **after Tasks 9 and 10**, because it imports `./local` and `./external` statically. Everything from Task 4 onwards depends on it, so it runs before Task 4 even though it is numbered here.

`require()` is not used anywhere in this repo's TypeScript — the house pattern is `await import()`. Static imports are correct here because the weight is not in these modules: `local.ts` only pulls `onnxruntime-node` inside `classify`, so importing it costs nothing in `off` mode.

**Files:**
- Create: `lib/nsfw/index.ts`
- Test: `lib/nsfw/index.test.ts`

**Interfaces:**
- Consumes: `readNsfwConfig`, `guard`, `offClassifier` (Task 3); `createLocalClassifier` (Task 9); `createExternalClassifier` (Task 10)
- Produces: `getClassifier(): Classifier`, `resetClassifierForTests(): void`, and the re-exports every other task imports from `@/lib/nsfw`

- [ ] **Step 1: Write the failing tests**

```ts
// lib/nsfw/index.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { getClassifier, resetClassifierForTests } from "./index";

afterEach(() => {
  resetClassifierForTests();
  vi.unstubAllEnvs();
});

describe("getClassifier", () => {
  it("hands back the off classifier when nothing is configured", async () => {
    const verdict = await getClassifier().classify(Buffer.from("x"));

    expect(verdict).toEqual({ label: "CLEAN", score: 0, model: "off" });
  });

  it("builds the classifier once per process", () => {
    // Otherwise every upload rebuilds it — and in local mode reloads the model.
    expect(getClassifier()).toBe(getClassifier());
  });

  it("falls back to off when the mode is misconfigured", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("NSFW_MODE", "external");   // no url, no key

    const verdict = await getClassifier().classify(Buffer.from("x"));

    expect(verdict.model).toBe("off");
    expect(warned).toHaveBeenCalled();
    warned.mockRestore();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/nsfw/index.test.ts`
Expected: FAIL — `Failed to resolve import "./index"`.

- [ ] **Step 3: Implement**

If Task 1's spike failed, omit the `createLocalClassifier` import and the `local` branch; `NSFW_MODES` no longer contains `"local"`, so the branch is unreachable anyway.

```ts
// lib/nsfw/index.ts
import { readNsfwConfig } from "./config";
import { createExternalClassifier } from "./external";
import { guard } from "./guard";
import { createLocalClassifier } from "./local";
import { offClassifier } from "./off";
import type { Classifier } from "./types";

export type { Classifier } from "./types";
export type { Verdict, VerdictLabel } from "./verdict";
export { labelFor, requiresReview, toVerdictLabel } from "./verdict";
export { readNsfwConfig } from "./config";

let cached: Classifier | undefined;

/**
 * The classifier this process uses, built once. In `off` mode no model is
 * loaded and no request is made: `local.ts` pulls its runtime inside
 * `classify`, so importing it above costs nothing until it is used.
 */
export function getClassifier(): Classifier {
  if (cached) return cached;

  const config = readNsfwConfig(process.env);
  if (config.mode === "off") {
    cached = offClassifier;
    return cached;
  }

  const inner =
    config.mode === "local"
      ? createLocalClassifier(config)
      : createExternalClassifier(config);

  cached = guard(inner, config.timeoutMs);
  return cached;
}

/** Tests only: drop the memoized classifier between cases. */
export function resetClassifierForTests(): void {
  cached = undefined;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/nsfw/`
Expected: PASS — every lib/nsfw suite green.

- [ ] **Step 5: Commit**

```bash
git add lib/nsfw/index.ts lib/nsfw/index.test.ts
git commit -m "feat(nsfw): select the classifier from the configured mode (#23)"
```

---

### Task 4: Report category for machine findings — `lib/reports.ts`

`components/ReportDialog.tsx:142` renders one radio per entry of `REPORT_CATEGORIES`. Adding `AUTO_NSFW` to that list would offer users "detected automatically" as something they can report. The user-selectable list and the full list must therefore be separate.

**Files:**
- Modify: `lib/reports.ts`
- Modify: `messages/de.json`, `messages/en.json`, `messages/it.json` (the `admin` namespace only)
- Test: `lib/reports.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `REPORT_CATEGORIES` — unchanged meaning: what a **user** may pick
  - `AUTO_REPORT_CATEGORIES = ["AUTO_NSFW"] as const`
  - `ALL_REPORT_CATEGORIES` — both, for reading back from the DB
  - `isReportCategory(value)` — now narrows against `ALL_REPORT_CATEGORIES`
  - `type ReportCategory` — widened to include `AUTO_NSFW`

- [ ] **Step 1: Write the failing tests**

```ts
// append to lib/reports.test.ts
import { AUTO_REPORT_CATEGORIES, REPORT_CATEGORIES, isReportCategory } from "./reports";

describe("machine-generated categories", () => {
  it("keeps AUTO_NSFW out of what a user can pick", () => {
    // ReportDialog renders one radio per REPORT_CATEGORIES entry; a machine
    // verdict is not something a person reports.
    expect(REPORT_CATEGORIES).not.toContain("AUTO_NSFW");
  });

  it("accepts AUTO_NSFW when reading a row back", () => {
    // The admin queue narrows every stored category before translating it.
    expect(isReportCategory("AUTO_NSFW")).toBe(true);
  });

  it("still accepts the user categories and rejects nonsense", () => {
    expect(isReportCategory("NSFW")).toBe(true);
    expect(isReportCategory("SOMETHING_ELSE")).toBe(false);
  });

  it("names exactly one machine category", () => {
    expect(AUTO_REPORT_CATEGORIES).toEqual(["AUTO_NSFW"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/reports.test.ts`
Expected: FAIL — `AUTO_REPORT_CATEGORIES` is not exported, and `isReportCategory("AUTO_NSFW")` is `false`.

- [ ] **Step 3: Implement**

```ts
// lib/reports.ts — replace the category block, leave the rest of the file alone

/** What a *person* may choose in the report dialog. */
export const REPORT_CATEGORIES = ["NSFW", "ILLEGAL", "COPYRIGHT", "OTHER"] as const;

/**
 * Categories only the server produces. Kept out of REPORT_CATEGORIES because
 * components/ReportDialog.tsx renders one radio per entry of that list — a
 * machine verdict must not become something a user can pick.
 */
export const AUTO_REPORT_CATEGORIES = ["AUTO_NSFW"] as const;

/** Everything a stored row may contain. */
export const ALL_REPORT_CATEGORIES = [
  ...REPORT_CATEGORIES,
  ...AUTO_REPORT_CATEGORIES,
] as const;

export type UserReportCategory = (typeof REPORT_CATEGORIES)[number];
export type ReportCategory = (typeof ALL_REPORT_CATEGORIES)[number];

// Guard for DB → typed-value boundaries: category columns are plain strings,
// so anything read back must be narrowed before it reaches a translation
// lookup like t(`category${category}`), which throws on an unknown key.
export function isReportCategory(value: string): value is ReportCategory {
  return (ALL_REPORT_CATEGORIES as readonly string[]).includes(value);
}
```

- [ ] **Step 4: Add the admin label in all three locales**

Only the `admin` namespace — the `report` namespace is the user dialog and must not gain the key.

```json
// messages/de.json → "admin"
"categoryAUTO_NSFW": "Automatisch erkannt",
// messages/en.json → "admin"
"categoryAUTO_NSFW": "Detected automatically",
// messages/it.json → "admin"
"categoryAUTO_NSFW": "Rilevato automaticamente",
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run lib/reports.test.ts lib/messages.test.ts`
Expected: PASS — including the catalogue-parity test, which fails if one locale is missing the key.

- [ ] **Step 6: Commit**

```bash
git add lib/reports.ts lib/reports.test.ts messages/
git commit -m "feat(reports): a category for findings the server made itself (#23)"
```

---

### Task 5: The `ImageVerdict` model

**Files:**
- Modify: `prisma/schema.prisma`
- Test: covered by Tasks 6 and 7 against the real client

**Interfaces:**
- Consumes: nothing
- Produces: `prisma.imageVerdict` with fields `imageKey` (PK, String), `label` (String), `score` (Float), `model` (String), `createdAt` (DateTime)

- [ ] **Step 1: Add the model**

```prisma
// prisma/schema.prisma — append

// The classifier's judgement of one stored image, keyed by the object key so
// it survives between the upload request and the puzzle that claims it. Never
// sent to the client: a verdict that travelled through the browser could be
// rewritten by the uploader.
//
// label is a plain string ("CLEAN" | "FLAGGED" | "UNKNOWN", see
// lib/nsfw/verdict.ts) because SQLite has no enums — same as Role and
// Report.status. Rows whose key no puzzle references are swept by
// lib/retention.ts.
model ImageVerdict {
  imageKey  String   @id
  label     String
  score     Float
  model     String
  createdAt DateTime @default(now())

  // The retention sweep selects by age.
  @@index([createdAt])
}
```

- [ ] **Step 2: Apply to both providers**

```bash
npm run db:push
DATABASE_PROVIDER=sqlite npm run db:push
```
Expected: both report the schema in sync. If the second command differs in this repo, follow `.claude/skills/db-change`.

- [ ] **Step 3: Confirm the client has the model**

Run: `node -e "const {PrismaClient}=require('./lib/generated/prisma'); console.log(typeof new PrismaClient().imageVerdict.findUnique)"`
Expected: prints `function`.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat(nsfw): store one verdict per uploaded image (#23)"
```

---

### Task 6: Classify in the upload route

**Files:**
- Modify: `app/api/upload/route.ts`
- Test: `app/api/upload/route.test.ts`

**Interfaces:**
- Consumes: `getClassifier` (Task 3), `labelFor` (Task 2), `prisma.imageVerdict` (Task 5)
- Produces: an `ImageVerdict` row per successful upload; the response body is unchanged

- [ ] **Step 1: Write the failing tests**

```ts
// app/api/upload/route.test.ts — add to the existing mocks and cases
const { classifyMock, verdictCreate } = vi.hoisted(() => ({
  classifyMock: vi.fn(),
  verdictCreate: vi.fn(),
}));

vi.mock("@/lib/nsfw", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/nsfw")>()),
  getClassifier: () => ({ classify: classifyMock }),
}));

describe("classification", () => {
  beforeEach(() => {
    classifyMock.mockResolvedValue({ label: "CLEAN", score: 0.02, model: "fake" });
    verdictCreate.mockResolvedValue({});
  });

  it("judges the re-encoded bytes, not the upload", async () => {
    // The stored WebP is what gets served, so it is what must be judged.
    await POST(uploadRequest(jpegFixture));

    const judged = classifyMock.mock.calls[0][0] as Buffer;
    expect(judged.subarray(8, 12).toString()).toBe("WEBP");
  });

  it("stores the verdict against the key it wrote", async () => {
    const res = await POST(uploadRequest(jpegFixture));
    const { imageKey } = await res.json();

    expect(verdictCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ imageKey, label: "CLEAN", model: "fake" }),
      }),
    );
  });

  it("never tells the client what the verdict was", async () => {
    // A client that learns the score learns the threshold.
    classifyMock.mockResolvedValue({ label: "FLAGGED", score: 0.97, model: "fake" });

    const body = await (await POST(uploadRequest(jpegFixture))).text();

    expect(body).not.toContain("FLAGGED");
    expect(body).not.toContain("0.97");
  });

  it("still stores the image when writing the verdict fails", async () => {
    // The bytes are already in storage; failing the upload now would lose an
    // image that exists. /api/puzzles treats a missing row as clean.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    verdictCreate.mockRejectedValue(new Error("db down"));

    const res = await POST(uploadRequest(jpegFixture));

    expect(res.status).toBe(201);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run app/api/upload/route.test.ts`
Expected: FAIL — `classifyMock` is never called and `verdictCreate` never runs.

- [ ] **Step 3: Implement**

```ts
// app/api/upload/route.ts — add the imports
import { prisma } from "@/lib/db";
import { getClassifier } from "@/lib/nsfw";

// …and replace the block from `const imageKey = …` to the return with:

  const imageKey = `puzzles/${randomUUID()}.webp`;

  // Judge the re-encoded bytes, before they are stored: what gets served is
  // what gets judged. The guard in lib/nsfw turns any failure into UNKNOWN,
  // so this never throws and never blocks the upload.
  const verdict = await getClassifier().classify(output);

  await putObject(imageKey, output, "image/webp");

  try {
    await prisma.imageVerdict.create({
      data: {
        imageKey,
        label: verdict.label,
        score: verdict.score,
        model: verdict.model,
      },
    });
  } catch (error) {
    // The bytes are already stored, so failing here would lose an image that
    // exists. /api/puzzles treats a missing verdict as clean — a narrow, known
    // hole, preferred over a 500 on an upload that otherwise worked.
    console.error(`[nsfw] could not record the verdict for ${imageKey}:`, error);
  }

  // The verdict is deliberately absent from the response: a client that learns
  // the score learns the threshold.
  return NextResponse.json({ imageKey, width, height }, { status: 201 });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run app/api/upload/route.test.ts`
Expected: PASS, including the pre-existing cases.

- [ ] **Step 5: Commit**

```bash
git add app/api/upload/route.ts app/api/upload/route.test.ts
git commit -m "feat(nsfw): classify the stored bytes during upload (#23)"
```

---

### Task 7: Act on the verdict when the puzzle is created

**Files:**
- Modify: `app/api/puzzles/route.ts`
- Test: `app/api/puzzles/route.test.ts`

**Interfaces:**
- Consumes: `toVerdictLabel`, `requiresReview` (Task 2), `AUTO_REPORT_CATEGORIES` (Task 4), `prisma.imageVerdict` (Task 5)
- Produces: `POST /api/puzzles` responds `{ id, pendingReview: boolean }`

- [ ] **Step 1: Write the failing tests**

```ts
// app/api/puzzles/route.test.ts
describe("automatic moderation", () => {
  beforeEach(() => {
    verdictFindUnique.mockResolvedValue(null);
    reportCreate.mockResolvedValue({});
  });

  it("publishes a clean image as asked", async () => {
    verdictFindUnique.mockResolvedValue({ label: "CLEAN", score: 0.01, model: "fake" });

    const res = await POST(createRequest({ isPublic: true }));

    expect(puzzleCreate.mock.calls[0][0].data.isPublic).toBe(true);
    expect(reportCreate).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toMatchObject({ pendingReview: false });
  });

  it("holds a flagged image private and queues it", async () => {
    verdictFindUnique.mockResolvedValue({ label: "FLAGGED", score: 0.97, model: "fake-1" });

    const res = await POST(createRequest({ isPublic: true }));

    expect(puzzleCreate.mock.calls[0][0].data.isPublic).toBe(false);
    await expect(res.json()).resolves.toMatchObject({ pendingReview: true });
  });

  it("files the report as the server's own finding, not a person's", async () => {
    // A reporter identity here would invent a person who never reported.
    verdictFindUnique.mockResolvedValue({ label: "FLAGGED", score: 0.97, model: "fake-1" });

    await POST(createRequest({ isPublic: true }));

    expect(reportCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          category: "AUTO_NSFW",
          status: "OPEN",
          reporterEmail: null,
          reporterIpHash: null,
        }),
      }),
    );
  });

  it("records the score and model so an admin can see why", async () => {
    verdictFindUnique.mockResolvedValue({ label: "FLAGGED", score: 0.97, model: "fake-1" });

    await POST(createRequest({ isPublic: true }));

    const { message } = reportCreate.mock.calls[0][0].data;
    expect(message).toContain("0.97");
    expect(message).toContain("fake-1");
  });

  it("treats an unusable verdict exactly like a hit", async () => {
    verdictFindUnique.mockResolvedValue({ label: "UNKNOWN", score: 0, model: "error" });

    await POST(createRequest({ isPublic: true }));

    expect(puzzleCreate.mock.calls[0][0].data.isPublic).toBe(false);
    expect(reportCreate).toHaveBeenCalled();
  });

  it("treats an image with no verdict as clean", async () => {
    // Uploaded before this feature, or in off mode.
    verdictFindUnique.mockResolvedValue(null);

    await POST(createRequest({ isPublic: true }));

    expect(puzzleCreate.mock.calls[0][0].data.isPublic).toBe(true);
    expect(reportCreate).not.toHaveBeenCalled();
  });

  it("does not make a flagged puzzle public just because the user asked for private", async () => {
    verdictFindUnique.mockResolvedValue({ label: "FLAGGED", score: 0.9, model: "fake-1" });

    await POST(createRequest({ isPublic: false }));

    expect(puzzleCreate.mock.calls[0][0].data.isPublic).toBe(false);
  });

  it("rejects a stored label it does not recognise instead of publishing", async () => {
    verdictFindUnique.mockResolvedValue({ label: "sortof", score: 0.5, model: "fake" });

    await POST(createRequest({ isPublic: true }));

    expect(puzzleCreate.mock.calls[0][0].data.isPublic).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run app/api/puzzles/route.test.ts`
Expected: FAIL — `isPublic` is whatever the request asked for and no report is created.

- [ ] **Step 3: Implement**

```ts
// app/api/puzzles/route.ts — add the imports
import { requiresReview, toVerdictLabel } from "@/lib/nsfw";
import { AUTO_REPORT_CATEGORIES } from "@/lib/reports";

// …then between the `foreign` check and `computeGrid`:

  // What the classifier decided at upload time. A missing row means the image
  // predates this feature or was uploaded with NSFW_MODE=off, both of which
  // are clean. An unreadable label is not: a column we cannot narrow is held
  // for review rather than published.
  const stored = await prisma.imageVerdict.findUnique({
    where: { imageKey },
    select: { label: true, score: true, model: true },
  });
  const label = stored ? (toVerdictLabel(stored.label) ?? "UNKNOWN") : "CLEAN";
  const pendingReview = requiresReview(label);

// …change the create call's isPublic:
      isPublic: isPublic && !pendingReview,

// …and after the puzzle is created, before the response:

  if (pendingReview) {
    // Into #22's queue, with no reporter: this is the server's own finding,
    // and inventing a reporter identity would put a person's name on it.
    await prisma.report.create({
      data: {
        puzzleId: puzzle.id,
        puzzleTitle: title,
        category: AUTO_REPORT_CATEGORIES[0],
        message: `Automatic classification: ${label}, score ${stored?.score ?? 0}, model ${stored?.model ?? "unknown"}.`,
        reporterEmail: null,
        reporterIpHash: null,
        status: "OPEN",
      },
    });
  }

  return NextResponse.json({ id: puzzle.id, pendingReview }, { status: 201 });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run app/api/puzzles/route.test.ts`
Expected: PASS, 8 new cases plus the existing ones.

- [ ] **Step 5: Commit**

```bash
git add app/api/puzzles/route.ts app/api/puzzles/route.test.ts
git commit -m "feat(nsfw): hold a flagged puzzle private and queue it for review (#23)"
```

---

### Task 8: Tell the uploader, in three locales

`components/CreateForm.tsx` navigates to `/puzzle/<id>` immediately on success, so the note cannot live on the form. It travels as a query parameter and is rendered by the puzzle page for the owner.

**Files:**
- Modify: `components/CreateForm.tsx` (the `router.push` after creation)
- Modify: `app/[locale]/puzzle/[id]/page.tsx`
- Modify: `messages/de.json`, `messages/en.json`, `messages/it.json` (the `solve` namespace)
- Test: `components/CreateForm.test.tsx`

**Interfaces:**
- Consumes: `pendingReview` from Task 7's response
- Produces: navigation to `/puzzle/<id>?review=1` when `pendingReview` is true

- [ ] **Step 1: Write the failing test**

```ts
// components/CreateForm.test.tsx
it("sends the uploader to the review note when the puzzle is held back", async () => {
  // Without it the puzzle is simply missing from the public list and the user
  // reads that as a bug — and uploads it again.
  respondToCreateWith({ id: "puzzle-1", pendingReview: true });

  await submitForm();

  expect(pushMock).toHaveBeenCalledWith("/puzzle/puzzle-1?review=1");
});

it("goes straight to the puzzle when nothing was flagged", async () => {
  respondToCreateWith({ id: "puzzle-1", pendingReview: false });

  await submitForm();

  expect(pushMock).toHaveBeenCalledWith("/puzzle/puzzle-1");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run components/CreateForm.test.tsx`
Expected: FAIL — the push is always `/puzzle/puzzle-1`.

- [ ] **Step 3: Implement the redirect**

```tsx
// components/CreateForm.tsx — replace the success navigation
      router.push(data.pendingReview ? `/puzzle/${data.id}?review=1` : `/puzzle/${data.id}`);
```

- [ ] **Step 4: Add the three strings**

Neutral wording: no score, no accusation. Under the `solve` namespace, which the puzzle page already uses.

```json
// messages/de.json → "solve"
"reviewPending": "Dieses Puzzle ist zunächst privat und wird geprüft. Sobald die Prüfung abgeschlossen ist, kannst du es öffentlich schalten.",
// messages/en.json → "solve"
"reviewPending": "This puzzle is private for now and is being reviewed. Once the review is done you can make it public.",
// messages/it.json → "solve"
"reviewPending": "Questo puzzle è per ora privato ed è in corso una verifica. Al termine potrai renderlo pubblico.",
```

- [ ] **Step 5: Render the note for the owner**

```tsx
// app/[locale]/puzzle/[id]/page.tsx — inside the page component, after the
// puzzle and session are resolved. searchParams is already a Promise in this
// App Router version; await it like params.
  const { review } = await searchParams;
  const showReviewNote = review === "1" && session?.id === puzzle.ownerId;

// …and in the markup, above the board:
  {showReviewNote && <p className="muted">{t("reviewPending")}</p>}
```

- [ ] **Step 6: Run the tests and the catalogue check**

Run: `npx vitest run components/CreateForm.test.tsx lib/messages.test.ts`
Expected: PASS — parity across the three locales included.

- [ ] **Step 7: Commit**

```bash
git add components/CreateForm.tsx "app/[locale]/puzzle/[id]/page.tsx" components/CreateForm.test.tsx messages/
git commit -m "feat(nsfw): tell the uploader their puzzle is awaiting review (#23)"
```

---

### Task 9: The local classifier — `lib/nsfw/local.ts`

**The spike passed, so this task ships.** It settled three things that override this task's original wording — the design doc's "The local model: spike result" section is authoritative and must be read before starting:

- The package is **`onnxruntime-web@1.27.0`**, not `onnxruntime-node`. The latter's prebuilt native binary does not load on the project's `node:22-alpine` base image (musl/glibc ABI mismatch); `onnxruntime-web` is pure WASM and runs there.
- The import form is **`import * as ort from "onnxruntime-web"`**.
- **`next.config.ts` must gain `"onnxruntime-web"` in `serverExternalPackages`, alongside `"sharp"`.** This was reproduced, not reasoned: without it `npm run build` passes and the route fails at *runtime* with `ERR_MODULE_NOT_FOUND` on the WASM loader's companion file.

Model: `OwenElliott/image-safety-classifier-xs`, MIT, 13.1 MB. Input tensor `"image"`, float32, `[1, 3, 224, 224]` NCHW, raw 0–255 values — normalisation is baked into the graph, so do **not** apply mean/std or a /255 scale. Output tensor `"probabilities"`, `[1, 3]`, already soft-maxed, class order `["NSFL", "NSFW", "SFW"]` — the explicit-content score this task returns is index **1**. (The `mean`/`std` in the model's `config.json` belong to the original timm recipe, not the exported graph; ignore them.)

**Files:**
- Create: `lib/nsfw/local.ts`
- Test: `lib/nsfw/local.test.ts`
- Modify: `package.json` (`onnxruntime-web`), `next.config.ts` (`serverExternalPackages`), `Dockerfile` (the model file)

**Interfaces:**
- Consumes: `NsfwConfig` (Task 3), `labelFor` (Task 2)
- Produces: `createLocalClassifier(config: NsfwConfig, run?: Score): Classifier`

- [ ] **Step 1: Write the failing test**

The inference session is injected so the test never loads a model.

```ts
// lib/nsfw/local.test.ts
import { describe, expect, it, vi } from "vitest";
import { createLocalClassifier } from "./local";
import { DEFAULT_THRESHOLD, DEFAULT_TIMEOUT_MS } from "./config";

const config = {
  mode: "local" as const,
  threshold: DEFAULT_THRESHOLD,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  apiUrl: null,
  apiKey: null,
};

describe("createLocalClassifier", () => {
  it("turns the model's score into a verdict", async () => {
    const run = vi.fn(async () => 0.93);
    const verdict = await createLocalClassifier(config, run).classify(Buffer.from("x"));

    expect(verdict.label).toBe("FLAGGED");
    expect(verdict.score).toBe(0.93);
  });

  it("names the model in the verdict, so an old row can be re-checked", async () => {
    const verdict = await createLocalClassifier(config, async () => 0.1).classify(Buffer.from("x"));

    expect(verdict.model).toMatch(/^local:/);
  });

  it("loads the session only once across calls", async () => {
    // Otherwise every upload pays the load cost.
    const run = vi.fn(async () => 0.1);
    const classifier = createLocalClassifier(config, run);

    await classifier.classify(Buffer.from("a"));
    await classifier.classify(Buffer.from("b"));

    expect(run).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/nsfw/local.test.ts`
Expected: FAIL — `Failed to resolve import "./local"`.

- [ ] **Step 3: Implement, complete, from the spike's result**

Write the real preprocessing in this step — the tensor shape, normalisation and output index the spike recorded in the design doc. **Do not commit a stub or a `throw` standing in for it:** a placeholder in production code is indistinguishable from a defect to anyone reading the diff later, and this task's own Step 5 cannot pass while one is there. If the spike's notes are not specific enough to write this, stop and report `NEEDS_CONTEXT` rather than filling the gap with a placeholder.

`MODEL_ID` takes the package, file name and version from the spike. The `run` parameter exists so the test can inject a scorer; production uses `defaultRun`.

```ts
// lib/nsfw/local.ts
import type { NsfwConfig } from "./config";
import type { Classifier } from "./types";
import { labelFor } from "./verdict";

/** Set from the spike in Task 1 — package, file name and version. */
const MODEL_ID = "local:<model-name>@<version>";

/** Returns the probability that `bytes` is explicit, in 0..1. */
type Score = (bytes: Buffer) => Promise<number>;

let session: unknown;

const defaultRun: Score = async (bytes) => {
  const ort = await import("onnxruntime-web");
  // Loaded once per process: the first upload after a start pays for it, the
  // rest do not.
  session ??= await ort.InferenceSession.create(process.env.NSFW_MODEL_PATH ?? "./models/nsfw.onnx");
  // Preprocessing and the output-to-probability step exactly as the spike
  // recorded them: resize to the model's input size, normalise, build the
  // tensor in the model's layout, run, read the explicit-class probability.
  // …written out here, in full, from the design doc's spike section.
};

export function createLocalClassifier(config: NsfwConfig, run: Score = defaultRun): Classifier {
  return {
    async classify(bytes) {
      const score = await run(bytes);
      return { label: labelFor(score, config.threshold), score, model: MODEL_ID };
    },
  };
}
```

- [ ] **Step 4: Wire the package and the model into the build**

Three separate things, all required:

1. `npm install onnxruntime-web@1.27.0` — this task is the one that adds it to `package.json` and the lockfile.
2. `next.config.ts`: add `"onnxruntime-web"` to `serverExternalPackages`, so the list reads `["sharp", "onnxruntime-web"]`. Without this the build succeeds and the route fails at runtime — verify by running `npm run build` and actually exercising the classifier, not by reading the config.
3. `Dockerfile`: `COPY` the model file next to the other assets, and set `NSFW_MODEL_PATH` in `docker-compose.yml` alongside the other NSFW variables from Task 12.

- [ ] **Step 5: Verify against a real image, outside the test suite**

`lib/nsfw` is TypeScript, so `node -e` cannot load it — run the check through `tsx`, which `npx` fetches on demand without adding a dependency.

```bash
cat > /tmp/nsfw-check.ts <<'TS'
import { readFileSync } from "node:fs";
import { getClassifier } from "./lib/nsfw";
getClassifier().classify(readFileSync(process.argv[2])).then(console.log);
TS
NSFW_MODE=local npx tsx /tmp/nsfw-check.ts ./path/to/a/harmless.webp
rm /tmp/nsfw-check.ts
```
Expected: a `CLEAN` verdict with a low score and `model` starting `local:`. A verdict of `UNKNOWN` with `model: "error"` means the guard caught a throw — read the logged error.

- [ ] **Step 6: Run the suite and commit**

Run: `npx vitest run lib/nsfw/`

```bash
git add lib/nsfw/local.ts lib/nsfw/local.test.ts package.json package-lock.json Dockerfile
git commit -m "feat(nsfw): local classification with an on-device model (#23)"
```

---

### Task 10: The external classifier — `lib/nsfw/external.ts`

**Files:**
- Create: `lib/nsfw/external.ts`
- Test: `lib/nsfw/external.test.ts`

**Interfaces:**
- Consumes: `NsfwConfig` (Task 3), `labelFor` (Task 2)
- Produces: `createExternalClassifier(config: NsfwConfig): Classifier`

- [ ] **Step 1: Write the failing tests**

`fetch` is stubbed; no test reaches the network.

```ts
// lib/nsfw/external.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExternalClassifier } from "./external";

const config = {
  mode: "external" as const,
  threshold: 0.85,
  timeoutMs: 5000,
  apiUrl: "https://classifier.example/check",
  apiKey: "secret",
};

afterEach(() => vi.unstubAllGlobals());

function respondWith(init: { ok: boolean; status?: number; body?: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: init.ok,
      status: init.status ?? (init.ok ? 200 : 500),
      json: async () => init.body,
    })),
  );
}

describe("createExternalClassifier", () => {
  it("turns the service's score into a verdict", async () => {
    respondWith({ ok: true, body: { score: 0.91 } });

    const verdict = await createExternalClassifier(config).classify(Buffer.from("x"));

    expect(verdict.label).toBe("FLAGGED");
    expect(verdict.score).toBe(0.91);
  });

  it("sends the key and the bytes to the configured url", async () => {
    respondWith({ ok: true, body: { score: 0.1 } });

    await createExternalClassifier(config).classify(Buffer.from("x"));

    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://classifier.example/check");
    expect(init.headers.Authorization).toContain("secret");
    expect(init.method).toBe("POST");
  });

  it("throws on a refusal, so the guard can hold the image", async () => {
    // Not a silent CLEAN: a service that is down must not publish everything.
    respondWith({ ok: false, status: 503 });

    await expect(
      createExternalClassifier(config).classify(Buffer.from("x")),
    ).rejects.toThrow();
  });

  it("throws on a response without a usable score", async () => {
    respondWith({ ok: true, body: { verdict: "probably fine" } });

    await expect(
      createExternalClassifier(config).classify(Buffer.from("x")),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/nsfw/external.test.ts`
Expected: FAIL — `Failed to resolve import "./external"`.

- [ ] **Step 3: Implement**

It throws rather than handling anything: `guard` from Task 3 owns the failure policy.

```ts
// lib/nsfw/external.ts
import type { NsfwConfig } from "./config";
import type { Classifier } from "./types";
import { labelFor } from "./verdict";

/**
 * Classification by a third-party service. Every failure throws — the guard in
 * lib/nsfw/guard.ts turns it into UNKNOWN — so there is one failure policy in
 * the codebase rather than one per mode.
 *
 * Sends the re-encoded WebP, never the original upload. This mode makes the
 * service an Art. 28 processor; see docs/data-processors.md.
 */
export function createExternalClassifier(config: NsfwConfig): Classifier {
  const { apiUrl, apiKey, threshold } = config;
  if (!apiUrl || !apiKey) throw new Error("external classifier needs NSFW_API_URL and NSFW_API_KEY");

  return {
    async classify(bytes) {
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "image/webp",
        },
        body: new Uint8Array(bytes),
      });

      if (!res.ok) throw new Error(`classifier answered ${res.status}`);

      const body = (await res.json()) as { score?: unknown };
      const score = typeof body.score === "number" ? body.score : Number.NaN;
      if (!Number.isFinite(score)) throw new Error("classifier response had no usable score");

      return { label: labelFor(score, threshold), score, model: `external:${new URL(apiUrl).host}` };
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/nsfw/external.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/nsfw/external.ts lib/nsfw/external.test.ts
git commit -m "feat(nsfw): classification by an external service (#23)"
```

---

### Task 11: Sweep verdicts no puzzle claimed

**Files:**
- Modify: `lib/retention.ts`
- Test: `lib/retention.test.ts`

**Interfaces:**
- Consumes: `prisma.imageVerdict` (Task 5)
- Produces: `purgeOrphanedVerdicts(now?: number): Promise<number>`, called from `maybePurgeExpiredTokens`

- [ ] **Step 1: Write the failing tests**

```ts
// lib/retention.test.ts
describe("purgeOrphanedVerdicts", () => {
  it("deletes a verdict older than the grace period that no puzzle claimed", async () => {
    // An abandoned upload would otherwise keep its row for the life of the DB.
    await purgeOrphanedVerdicts(NOW);

    expect(verdictDeleteMany).toHaveBeenCalledWith({
      where: {
        createdAt: { lt: new Date(NOW - VERDICT_GRACE_MS) },
        imageKey: { notIn: expect.any(Array) },
      },
    });
  });

  it("keeps a verdict whose image a puzzle still uses", async () => {
    puzzleFindMany.mockResolvedValue([{ imageKey: "puzzles/kept.webp" }]);

    await purgeOrphanedVerdicts(NOW);

    const { where } = verdictDeleteMany.mock.calls[0][0];
    expect(where.imageKey.notIn).toContain("puzzles/kept.webp");
  });

  it("runs as part of the sweep, so no operator has to schedule it", async () => {
    await maybePurgeExpiredTokens(NOW);

    expect(verdictDeleteMany).toHaveBeenCalled();
  });

  it("does not let a verdict failure stop the token purge from counting", async () => {
    // Token deletion is the promise the privacy policy makes; verdict cleanup
    // is housekeeping and must not mask it.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    verdictDeleteMany.mockRejectedValue(new Error("db down"));

    await expect(maybePurgeExpiredTokens(NOW)).resolves.not.toBeNull();
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/retention.test.ts`
Expected: FAIL — `purgeOrphanedVerdicts` is not exported.

- [ ] **Step 3: Implement**

```ts
// lib/retention.ts — add near purgeExpiredTokens

/** How long an unclaimed verdict is kept, in case the puzzle is still coming. */
export const VERDICT_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Delete verdicts for images no puzzle references. An upload the user
 * abandoned leaves a row behind that nothing will ever read; the grace period
 * covers the gap between the upload request and the puzzle that claims it.
 */
export async function purgeOrphanedVerdicts(now: number = Date.now()): Promise<number> {
  const claimed = await prisma.puzzle.findMany({ select: { imageKey: true } });

  const { count } = await prisma.imageVerdict.deleteMany({
    where: {
      createdAt: { lt: new Date(now - VERDICT_GRACE_MS) },
      imageKey: { notIn: claimed.map((p) => p.imageKey) },
    },
  });
  return count;
}
```

```ts
// lib/retention.ts — inside maybePurgeExpiredTokens's try, after the token count

    // Housekeeping, not the promise the privacy policy makes: its failure is
    // logged and swallowed so it can never stop a successful token purge from
    // being recorded as one.
    try {
      const orphans = await purgeOrphanedVerdicts(now);
      if (orphans > 0) console.info(`[retention] deleted ${orphans} unclaimed image verdict(s)`);
    } catch (error) {
      console.error("[retention] purge of unclaimed image verdicts failed:", error);
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/retention.test.ts`
Expected: PASS, 4 new cases plus the existing ones.

- [ ] **Step 5: Commit**

```bash
git add lib/retention.ts lib/retention.test.ts
git commit -m "feat(nsfw): sweep verdicts that no puzzle ever claimed (#23)"
```

---

### Task 12: Configuration reference, legal text and changelog

**Files:**
- Modify: `.env.example`, `docker-compose.yml`, `docker-compose.sqlite.yml`
- Modify: `docs/data-processors.md`
- Modify: `app/[locale]/legal/privacy/page.tsx`, `messages/de.json`, `messages/en.json`, `messages/it.json`
- Modify: `CHANGELOG.md`, `README.md`

- [ ] **Step 1: Document the variables**

Add to `.env.example` with the defaults from Global Constraints, and to both compose files, commented out so the default stays `off`:

```bash
# Image classification on upload. off (default) | local | external.
# NSFW_MODE=off
# NSFW_THRESHOLD=0.85
# NSFW_TIMEOUT_MS=5000
# external mode only — makes the service a processor, see docs/data-processors.md
# NSFW_API_URL=
# NSFW_API_KEY=
```

- [ ] **Step 2: Correct `docs/data-processors.md`**

The section "What deliberately does *not* leave the instance" currently covers uploaded images without qualification. Condition it on the mode, and add a row to the operator table:

```markdown
| Image classifier (`NSFW_API_URL`), only when `NSFW_MODE=external` | | the re-encoded WebP of every upload | | |
```

Add a subsection under "What can leave the instance" stating that in `external` mode every uploaded image is sent to the configured service, that `off` and `local` send nothing, and that the default is `off`.

- [ ] **Step 3: Extend the privacy policy**

One paragraph in the `legal` namespace of all three locales, conditioned on the mode being external — the operator fills in the service. Follow the wording pattern already used for SMTP and S3 in that page.

- [ ] **Step 4: Changelog**

```markdown
### Added
- Optional NSFW classification of uploaded images (`NSFW_MODE`, off by
  default). A flagged image still uploads, but the puzzle is created private
  and appears in the admin review queue instead of being published; a
  classifier that fails or times out is treated the same way. Operators can run
  a local model or an external service — the latter is an Art. 28 processor,
  see `docs/data-processors.md`. (#23)
```

- [ ] **Step 5: Run every gate**

```bash
npm run lint && npm test && npm run build
```
Expected: all three clean. This is the state the PR is opened from.

- [ ] **Step 6: Commit**

```bash
git add .env.example docker-compose.yml docker-compose.sqlite.yml docs/data-processors.md "app/[locale]/legal/privacy/page.tsx" messages/ CHANGELOG.md README.md
git commit -m "docs(nsfw): configuration, processor disclosure and changelog (#23)"
```

---

## Self-review

**Spec coverage.** Three modes → Task 3. Accept-and-queue → Task 7. Failure treated as a hit → Task 3 (guard) and Task 7 (`UNKNOWN` path). Neutral note to the uploader → Task 8. Verdict table keyed by `imageKey` → Task 5. Classification of the re-encoded bytes → Task 6. `AUTO_NSFW` in #22's queue → Tasks 4 and 7. Cleanup → Task 11. Docs and legal text → Task 12. Local model decision rule → Task 1. No spec section is unimplemented.

**Two things this plan adds that the spec did not settle:**
1. `AUTO_NSFW` must stay out of `REPORT_CATEGORIES`, because `components/ReportDialog.tsx:142` renders a radio per entry. Task 4 splits the user-selectable list from the full one.
2. `CreateForm` navigates away on success, so the note cannot live on the form. Task 8 carries it in a query parameter and renders it on the puzzle page for the owner.

**Type consistency.** `Verdict`/`VerdictLabel` (Task 2) are used unchanged in Tasks 3, 6, 7, 9 and 10. `createLocalClassifier` and `createExternalClassifier` match the names `getClassifier` requires in Task 3. `NsfwConfig` is produced in Task 3 and consumed in 9 and 10 with the same five fields. `pendingReview` is produced by Task 7 and consumed by Task 8.

**One deliberate placeholder, fenced.** `lib/nsfw/local.ts` Step 3 contains a `throw` standing in for the spike's preprocessing. It is called out in the step, replaced in Step 4, and Step 5 fails while it remains. Nothing else in the plan defers work.
