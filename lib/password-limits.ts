// The password length limits, free of zod and of every other import, so a
// "use client" component can quote them without dragging a schema library into
// the browser bundle. lib/password.ts re-exports them for server callers.

export const PASSWORD_MIN_LENGTH = 8;

/**
 * bcrypt hashes at most 72 bytes and silently ignores the rest, so a longer
 * passphrase would authenticate on its first 72 bytes alone with nothing
 * telling the user the tail was discarded. The limit is the algorithm's, so it
 * is counted in bytes, not characters — one emoji is four of them.
 */
export const PASSWORD_MAX_BYTES = 72;

export function passwordByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
