import { DEFAULT_LOCALE, LOCALES, type Locale } from './config';

interface LanguageRange {
  tag: string;
  quality: number;
}

/**
 * Parse an `Accept-Language` header into ranges ordered by descending q-value.
 * Wildcards (`*`) and malformed entries are handled defensively.
 */
export function parseAcceptLanguage(header: string | null | undefined): LanguageRange[] {
  if (!header) return [];
  return header
    .split(',')
    .map((part) => {
      const [tagRaw, ...params] = part.trim().split(';');
      const tag = tagRaw.trim();
      let quality = 1;
      for (const param of params) {
        const [name, value] = param.trim().split('=');
        if (name === 'q') {
          const parsed = Number.parseFloat(value ?? '');
          if (!Number.isNaN(parsed)) quality = parsed;
        }
      }
      return { tag, quality };
    })
    .filter((range) => range.tag.length > 0 && range.quality > 0)
    .sort((a, b) => b.quality - a.quality);
}

/** True when `available` tag and `requested` tag refer to the same language base. */
function sameLanguage(a: string, b: string): boolean {
  return a.split('-')[0]?.toLowerCase() === b.split('-')[0]?.toLowerCase();
}

/**
 * Pick the best shipped locale for an `Accept-Language` header.
 *
 * Exact tag match wins; otherwise the first shipped locale sharing a language
 * base (so `en` resolves to `en-US`). Falls back to `fallback`.
 */
export function negotiateLocale(
  header: string | null | undefined,
  available: readonly Locale[] = LOCALES,
  fallback: Locale = DEFAULT_LOCALE,
): Locale {
  const ranges = parseAcceptLanguage(header);
  for (const { tag } of ranges) {
    if (tag === '*') return fallback;
    const exact = available.find((locale) => locale.toLowerCase() === tag.toLowerCase());
    if (exact) return exact;
  }
  for (const { tag } of ranges) {
    const base = available.find((locale) => sameLanguage(locale, tag));
    if (base) return base;
  }
  return fallback;
}
