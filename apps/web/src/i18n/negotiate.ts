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

/** The script subtag of a BCP 47 tag (`Hant` for `zh-Hant-HK`), lowercased. */
function scriptOf(tag: string): string | undefined {
  return tag
    .split('-')
    .slice(1)
    .find((subtag) => subtag.length === 4)
    ?.toLowerCase();
}

/** The region subtag of a BCP 47 tag (`HK` for `zh-Hant-HK`), uppercased. */
function regionOf(tag: string): string | undefined {
  return tag
    .split('-')
    .slice(1)
    .find((subtag) => subtag.length === 2 || subtag.length === 3)
    ?.toUpperCase();
}

/**
 * Map Chinese variants onto the shipped catalogs.
 *
 * Traditional Chinese is shipped as two regional catalogs (`zh-TW`, `zh-HK`).
 * A request for the script-only `zh-Hant`, or for a region without a catalog
 * (`zh-MO`, `zh-SG` used with `Hant`), must land on Traditional rather than on
 * the Simplified default.
 */
function chineseVariant(tag: string): Locale | undefined {
  const script = scriptOf(tag);
  const region = regionOf(tag);
  if (script === 'hans') return 'zh-CN';
  if (script === 'hant') {
    return region === 'HK' || region === 'MO' ? 'zh-HK' : 'zh-TW';
  }
  if (region === 'TW') return 'zh-TW';
  if (region === 'HK' || region === 'MO') return 'zh-HK';
  return undefined;
}

/**
 * Pick the best shipped locale for an `Accept-Language` header.
 *
 * Resolution order:
 *   1. exact shipped tag (`zh-HK` → `zh-HK`),
 *   2. Chinese script/region variant (`zh-Hant`, `zh-Hant-HK`, `zh-MO` →
 *      Traditional; `zh-Hans-*` → Simplified),
 *   3. the first shipped locale sharing a language base (so `en` → `en-US`,
 *      `zh` → `zh-CN`).
 *
 * Falls back to `fallback` when nothing matches.
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
    const language = tag.split('-')[0]?.toLowerCase();
    if (language !== 'zh') continue;
    const variant = chineseVariant(tag);
    if (variant && available.includes(variant)) return variant;
  }
  for (const { tag } of ranges) {
    const base = available.find((locale) => sameLanguage(locale, tag));
    if (base) return base;
  }
  return fallback;
}
