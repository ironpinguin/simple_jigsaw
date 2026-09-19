// Operator details and instance-specific statements for the Impressum and the
// privacy policy.
//
// These live in the environment, not in the repository: this is a self-hostable
// app and the operator of an instance is typically a private individual whose
// name and postal address have no business being in a public git history.
//
// Nothing here is asserted by default. Every value describes the instance to the
// public, and a wrong statement on these two pages is a legal problem rather
// than a cosmetic one — so an undeclared processor, hosting region or
// non-commercial character is left unsaid instead of guessed. A missing name,
// address or email makes the Impressum name the variables that are unset, rather
// than render a page that looks complete but cannot satisfy § 5 DDG.
//
// The pages that read this must not be statically prerendered: in the Docker
// setup `next build` and the running container see different environments, so a
// prerender would bake in the build-time values (usually none at all). Both
// pages declare `export const dynamic = "force-dynamic"`, and `legal.test.ts`
// asserts the declaration is still there — the `[locale]` layout currently
// de-opts the whole segment anyway, so nothing else would notice its removal.

/** The date the privacy policy text last changed. Rendered per locale. */
export const PRIVACY_UPDATED = "2026-09-19";

/**
 * The current terms-of-use version, as the ISO date of the last substantive
 * change — purely editorial fixes do not bump it. Rendered on /legal/terms and
 * persisted on `User.termsVersion` at registration and invite acceptance, so a
 * later text change can tell who accepted what — see docs/terms-versioning.md
 * for how such a change is handled.
 */
export const TERMS_VERSION = "2026-08-05";

export interface LegalOperator {
  /** null when LEGAL_NAME is unset; the Impressum then refuses to render. */
  name: string | null;
  /**
   * Postal address, one entry per printed line. Fewer than two lines counts as
   * unconfigured — a street without a postcode and a locality is not an address
   * that can receive post.
   */
  addressLines: string[];
  /**
   * null when LEGAL_EMAIL is unset. Required, not optional: § 5 DDG asks for a
   * means of fast electronic contact, and it is where data subjects are sent to
   * exercise their GDPR rights.
   */
  email: string | null;
  /** null when LEGAL_PHONE is unset. Genuinely optional. */
  phone: string | null;
}

/** A `LegalOperator` carrying everything the Impressum has to print. */
export interface CompleteLegalOperator extends LegalOperator {
  name: string;
  email: string;
}

export interface LegalProcessors {
  /**
   * External mail provider, or null when LEGAL_MAIL_PROCESSOR is unset. Unset
   * means *not declared*, and the policy reads that as self-hosted mail — so it
   * has to be set whenever SMTP_HOST is somebody else's server.
   */
  mail: string | null;
  /**
   * External object-storage provider, or null when LEGAL_STORAGE_PROCESSOR is
   * unset. Same caveat as `mail`: set it whenever S3_ENDPOINT is not your own.
   */
  storage: string | null;
  /**
   * External NSFW classification service, or null when
   * LEGAL_CLASSIFIER_PROCESSOR is unset. Unlike `mail` and `storage`, unset
   * has no "self-hosted" claim to make: `NSFW_MODE=off` (the default) and
   * `=local` never send the image anywhere, so the page simply omits the
   * paragraph instead of asserting self-operation. Set this whenever
   * `NSFW_MODE=external` names a real service.
   */
  classifier: string | null;
}

export interface LegalInstance {
  /**
   * Where the instance runs, as it should be printed ("Deutschland", "the EU").
   * null when undeclared — the policy then says nothing about the location
   * instead of claiming the EU, which a self-hoster anywhere else would be
   * publishing as a falsehood.
   */
  hostingRegion: string | null;
  /**
   * Whether to state that the service is private and non-commercial, with no
   * register entry and no VAT ID. Opt-in: true only for LEGAL_PRIVATE_SERVICE
   * set to "true", because the statement is false for a commercial operator.
   */
  privateService: boolean;
}

// Deliberately the wide shape rather than a union of the LEGAL_* keys: an
// all-optional record is a weak type, which `process.env` is not assignable to,
// and the two casts needed to bridge that cost more than the typo check buys.
type Env = Record<string, string | undefined>;

function text(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Split LEGAL_ADDRESS into printable lines, on "|" as well as on newlines. The
 * pipe form is the one that survives everywhere: a `.env` file keeps a value on
 * a single line, and compose does not expand a `\n` escape the way dotenv does.
 * A real newline works too, for a shell export or a compose block scalar.
 */
export function addressLines(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(/[|\n]/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function legalOperator(env: Env = process.env): LegalOperator {
  return {
    name: text(env.LEGAL_NAME),
    addressLines: addressLines(env.LEGAL_ADDRESS),
    email: text(env.LEGAL_EMAIL),
    phone: text(env.LEGAL_PHONE),
  };
}

/**
 * The env vars an Impressum is missing, in the order they appear on the page, so
 * the "not configured" notice can name them instead of repeating a hardcoded
 * list in three message catalogs.
 */
export function missingOperatorFields(operator: LegalOperator): string[] {
  const missing: string[] = [];
  if (operator.name === null) missing.push("LEGAL_NAME");
  if (operator.addressLines.length < 2) missing.push("LEGAL_ADDRESS");
  if (operator.email === null) missing.push("LEGAL_EMAIL");
  return missing;
}

/**
 * An Impressum needs a name, a postal address and an electronic contact to be
 * one. A type predicate, so a guarded page stops treating those as nullable and
 * an unguarded one is a type error the moment it prints them.
 */
export function isOperatorComplete(operator: LegalOperator): operator is CompleteLegalOperator {
  return missingOperatorFields(operator).length === 0;
}

let warnedIncomplete = false;

/**
 * Tell the operator once per process that the Impressum is incomplete. Without
 * it the only feedback channel is loading the page in a browser, and nobody
 * loads their own Impressum. Deliberately not at module scope: that would also
 * fire during `next build`, where LEGAL_* is empty by design.
 */
export function warnIncompleteOperator(missing: string[]): void {
  if (warnedIncomplete || missing.length === 0) return;
  if (process.env.NODE_ENV !== "production") return;
  warnedIncomplete = true;
  console.warn(
    `[legal] Impressum incomplete, unset: ${missing.join(", ")} — ` +
      `/legal/imprint shows a placeholder instead of a valid Impressum.`,
  );
}

export function legalProcessors(env: Env = process.env): LegalProcessors {
  return {
    mail: text(env.LEGAL_MAIL_PROCESSOR),
    storage: text(env.LEGAL_STORAGE_PROCESSOR),
    classifier: text(env.LEGAL_CLASSIFIER_PROCESSOR),
  };
}

export function legalInstance(env: Env = process.env): LegalInstance {
  return {
    hostingRegion: text(env.LEGAL_HOSTING_REGION),
    privateService: text(env.LEGAL_PRIVATE_SERVICE)?.toLowerCase() === "true",
  };
}
