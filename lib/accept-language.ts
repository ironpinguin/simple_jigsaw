// Pure Accept-Language negotiation (no next/headers, no I/O) so it stays
// unit-testable. Deliberately hand-rolled: the only matcher packages in the
// tree are transitive dependencies of next-intl, and a handful of plain
// two-letter locales does not need them.
//
// This has to agree with next-intl's own negotiation to be useful — see the
// note in lib/i18n-server.ts and the header corpus in accept-language.test.ts.

interface Tag {
  readonly language: string;
  readonly quality: number;
}

function parse(header: string): Tag[] {
  return header
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.split(";").map((s) => s.trim());
      if (!tag) return null;

      // RFC 9110 §12.4.2 sets the default weight to 1 when no q is present. It
      // says nothing about malformed values; treating one as absent rather than
      // as a rejection is our choice, so a broken header degrades to header
      // order instead of dropping every tag.
      const q = params
        .map((p) => /^q=(.*)$/i.exec(p)?.[1])
        .find((value) => value !== undefined);
      const parsed = q === undefined ? 1 : Number.parseFloat(q);
      const quality = Number.isFinite(parsed) ? parsed : 1;

      return { language: tag.toLowerCase(), quality };
    })
    .filter((tag): tag is Tag => tag !== null && tag.quality > 0)
    // Sort is stable, so equal weights keep the order the header listed them in.
    .sort((a, b) => b.quality - a.quality);
}

/**
 * Best match for an `Accept-Language` header among `locales`, or `null` when the
 * header is missing or empty, names none of them, or rejects every tag it does
 * name with `q=0`.
 *
 * A tag matches a locale exactly (`de`) or as a subtag prefix (`en-US` → `en`,
 * `zh-Hans` → `zh`). A wildcard is deliberately ignored rather than matching
 * everything as RFC 4647 would have it: `*` expresses no preference, so the
 * caller's default is a better answer than whichever locale happens to be first.
 *
 * `locales` must be lowercase primary subtags — `en`, not `en-US` or `EN`.
 */
export function matchAcceptLanguage<T extends string>(
  header: string | null | undefined,
  locales: readonly [T, ...T[]],
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
