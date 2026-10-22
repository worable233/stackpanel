/**
 * Package-side interface translation (ADR-0016 §5).
 *
 * Plugin and theme frontends ship their own message catalogs next to their
 * components. They cannot import the kernel's `apps/web/src/i18n` module — the
 * package is compiled independently and runs behind the host ABI — so the SDK
 * provides the (deliberately tiny) resolution primitive instead.
 *
 * Design rules:
 * - The host owns locale negotiation and passes the resolved BCP 47 tag in
 *   props (`FrontendPageProps.locale`, `AccountPageComponentProps.locale`, …).
 * - Catalogs are plain `{ dotted.id: template }` maps. No CLDR plural rules,
 *   no nested lookup: a package's namespace is flat and local to that package,
 *   so there is nothing to collide with and nothing to merge.
 * - Fallback chain: requested locale → declared fallback locales → the id
 *   itself, so a missing message is visible rather than silently blank.
 */

/** A flat `dotted.id -> template` catalog for one locale. */
export type PackageCatalog = Record<string, string>;

/** All catalogs a package ships, keyed by BCP 47 tag. */
export type PackageCatalogs = Record<string, PackageCatalog>;

export type PackageMessageParams = Record<string, string | number>;

/**
 * The locale a package falls back to when the host does not provide one.
 *
 * Matches the kernel's site default (`apps/web/src/i18n/config.ts`). Pass this
 * to `Intl`/`formatMinorCurrency` so a package never hardcodes a literal tag.
 */
export const PACKAGE_FALLBACK_LOCALE = 'zh-CN' as const;

/** Resolve a message id and interpolate `{name}` placeholders. */
export type PackageTranslator = (key: string, params?: PackageMessageParams) => string;

/**
 * Replace `{name}` placeholders. Unknown placeholders are left intact so a
 * missing parameter is visible in the rendered copy.
 */
export function formatPackageMessage(template: string, params?: PackageMessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

/**
 * Expand a requested tag into the catalog tags to try, most specific first.
 *
 * A host may hand a package any BCP 47 tag (`zh-Hant`, `zh-Hant-HK`, `en-GB`),
 * while the package only ships a fixed set of catalogs (`zh-CN`, `zh-TW`,
 * `zh-HK`, `en-US`). Blindly falling back to the site default would show
 * Simplified Chinese to a Traditional Chinese reader, so the script subtag is
 * honoured for Chinese before the plain language base is considered.
 */
export function packageLocaleChain(
  locale: string | undefined,
  catalogs: PackageCatalogs,
): string[] {
  const available = Object.keys(catalogs);
  const chain: string[] = [];
  const push = (tag: string | undefined) => {
    if (!tag) return;
    const match = available.find((candidate) => candidate.toLowerCase() === tag.toLowerCase());
    if (match && !chain.includes(match)) chain.push(match);
  };

  push(locale);
  if (typeof locale === 'string') {
    const [language, ...subtags] = locale.split('-');
    const script = subtags.find((part) => part.length === 4)?.toLowerCase();
    const region = subtags
      .find((part) => part.length === 2 || part.length === 3)
      ?.toUpperCase();
    const base = language?.toLowerCase();

    if (base === 'zh') {
      if (script === 'hans') {
        push('zh-CN');
        push('zh-Hans');
      } else if (script === 'hant' || region === 'TW' || region === 'HK' || region === 'MO') {
        // Traditional Chinese: prefer the requested region, then the other
        // regional catalog, and never silently drop to Simplified.
        if (region === 'HK' || region === 'MO') {
          push('zh-HK');
          push('zh-TW');
        } else {
          push('zh-TW');
          push('zh-HK');
        }
        push('zh-Hant');
      }
    } else if (region) {
      // `en-GB` should still find the shipped `en-US` before the base lookup.
      push(`${language}-${region}`);
    }
  }
  if (typeof locale === 'string') {
    const base = locale.split('-')[0]?.toLowerCase();
    for (const candidate of available) {
      if (candidate.split('-')[0]?.toLowerCase() === base) push(candidate);
    }
  }
  return chain;
}

/**
 * Build a translator for one package.
 *
 * @param locale    Resolved interface locale from props (`undefined` falls back).
 * @param catalogs  The package's own catalogs.
 * @param fallbacks Additional locales to try in order. Packages should list the
 *                  site default first (the kernel's is `zh-CN`).
 */
export function createPackageTranslator(
  locale: string | undefined,
  catalogs: PackageCatalogs,
  fallbacks: readonly string[] = [],
): PackageTranslator {
  const chain = [...packageLocaleChain(locale, catalogs), ...fallbacks].filter(
    (tag, index, all) => typeof tag === 'string' && tag in catalogs && all.indexOf(tag) === index,
  );
  return (key, params) => {
    for (const tag of chain) {
      const template = catalogs[tag]?.[key];
      if (template !== undefined) return formatPackageMessage(template, params);
    }
    return key;
  };
}
