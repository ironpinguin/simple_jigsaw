// Pure Accept-Language negotiation (no next/headers, no I/O) so it stays
// unit-testable. Deliberately hand-rolled: the only matcher packages in the
// tree are transitive dependencies of next-intl, and this needs to handle
// exactly three locales.

interface Tag {
  language: string;
  quality: number;
  /** Position in the header, used to keep the original order on a tie. */
  index: number;
}

function parse(header: string): Tag[] {
  return header
    .split(",")
    .map((part, index) => {
      const [tag, ...params] = part.split(";").map((s) => s.trim());
      if (!tag) return null;

      // RFC 9110: q defaults to 1, and a malformed value is treated as absent
      // rather than as a rejection.
      const q = params
        .map((p) => /^q=(.*)$/i.exec(p)?.[1])
        .find((value) => value !== undefined);
      const parsed = q === undefined ? 1 : Number.parseFloat(q);
      const quality = Number.isFinite(parsed) ? parsed : 1;

      return { language: tag.toLowerCase(), quality, index };
    })
    .filter((tag): tag is Tag => tag !== null && tag.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index);
}

/**
 * Best match for an `Accept-Language` header among `locales`, or `null` when the
 * header is missing, empty or names none of them.
 *
 * A tag matches a locale exactly (`de`) or as its region variant (`en-US` →
 * `en`); a wildcard expresses no preference and is ignored, so the caller can
 * apply its own default.
 */
export function matchAcceptLanguage<T extends string>(
  header: string | null | undefined,
  locales: readonly T[],
): T | null {
  if (!header?.trim()) return null;

  for (const { language } of parse(header)) {
    const match = locales.find(
      (locale) => language === locale || language.startsWith(`${locale}-`),
    );
    if (match) return match;
  }
  return null;
}
