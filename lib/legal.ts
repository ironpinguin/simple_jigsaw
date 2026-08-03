// Operator details for the Impressum and the privacy policy.
//
// These live in the environment, not in the repository: this is a self-hostable
// app and the operator of an instance is typically a private individual whose
// name and postal address have no business being in a public git history. A
// missing value surfaces on the page as "not configured" instead of silently
// rendering an empty Impressum, which is worse than an obviously missing one.
//
// The pages that read this must not be statically prerendered — in the Docker
// setup `next build` and the running container see different environments.

export interface LegalOperator {
  name: string | null;
  /** Postal address, one entry per line as it should be printed. */
  addressLines: string[];
  email: string | null;
  phone: string | null;
}

export interface LegalProcessors {
  /** External mail provider, or null when mail is dispatched self-hosted. */
  mail: string | null;
  /** External object-storage provider, or null when images stay self-hosted. */
  storage: string | null;
}

type Env = Record<string, string | undefined>;

function text(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Split LEGAL_ADDRESS into printable lines. Accepts "|" as a separator so the
 * address survives an env file, a compose file and a shell export unharmed.
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

/** An Impressum needs at least a name and a postal address to be one. */
export function isOperatorComplete(operator: LegalOperator): boolean {
  return operator.name !== null && operator.addressLines.length > 0;
}

export function legalProcessors(env: Env = process.env): LegalProcessors {
  return {
    mail: text(env.LEGAL_MAIL_PROCESSOR),
    storage: text(env.LEGAL_STORAGE_PROCESSOR),
  };
}
