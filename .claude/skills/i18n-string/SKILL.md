---
name: i18n-string
description: Use when adding, renaming or removing any user-facing text in this repo — UI labels, buttons, validation and API error messages, or transactional email copy.
---

# Adding or changing a translated string

The app ships **three locales**: `de` (default), `en`, `it`. There is no
fallback — a key missing from one catalog throws at render time in that
language. Every string change touches all three files.

## Where strings live

| Where it appears | Namespace | Read via |
| --- | --- | --- |
| Pages and components | `nav`, `home`, `create`, `solve`, `my`, `auth`, `admin` | `useTranslations("<ns>")` |
| API route responses | `errors` | `getErrorT()` from `lib/i18n-server.ts` |
| Confirmation / invite mails | `email` | `getTranslations` with the recipient's locale |

Catalogs: `messages/de.json`, `messages/en.json`, `messages/it.json`. Locales and
the URL prefix routing are declared in `i18n/routing.ts`.

API routes are **not** locale-prefixed — `lib/i18n-server.ts` reads the caller's
language from the `NEXT_LOCALE` cookie that the next-intl middleware sets. So an
API error message needs a key in `errors`, not a hard-coded German string.

## The recipe

1. Add the key to `messages/de.json` first — DE is the source wording.
2. Copy the same key path into `en.json` and `it.json` with real translations.
   Keep the key order identical across the three files so diffs stay readable.
3. Use it: `const t = useTranslations("solve"); t("progress", { connected, total })`.
   Interpolation is ICU — every `{placeholder}` must survive into all three
   translations, and plural forms differ per language.
4. Run the parity check below.
5. Removing a string means removing it from all three catalogs.

## Parity check

```bash
node -e '
const fs = require("fs");
const load = (l) => JSON.parse(fs.readFileSync(`messages/${l}.json`, "utf8"));
const keys = (o, p = "") => Object.entries(o).flatMap(([k, v]) =>
  v && typeof v === "object" ? keys(v, `${p}${k}.`) : [`${p}${k}`]);
const de = keys(load("de"));
for (const l of ["en", "it"]) {
  const other = new Set(keys(load(l)));
  const missing = de.filter((k) => !other.has(k));
  const extra = [...other].filter((k) => !de.includes(k));
  if (missing.length || extra.length) console.log(l, { missing, extra });
}
console.log("checked", de.length, "keys");'
```

Silent apart from the key count = the catalogs agree.

## Common mistakes

- **Only `de.json` updated.** The most frequent failure. EN and IT users hit an
  error, not a fallback.
- **Hard-coded German in an API route.** Add an `errors.*` key and use
  `getErrorT()`.
- **English key names with German values** in `de.json` is fine and intended —
  key names are identifiers, not translations. Don't localise the keys.
- **Translating the ICU placeholders.** `{count}`, `{email}` stay verbatim.
- **A new locale is more than a file.** It needs an entry in `i18n/routing.ts`
  plus a full `messages/<locale>.json`.
- **Forgetting the changelog.** Visible copy changes are user-facing (see the
  `ship` skill).
