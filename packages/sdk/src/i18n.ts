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
  const chain = [locale, ...fallbacks].filter(
    (tag): tag is string => typeof tag === 'string' && tag in catalogs,
  );
  return (key, params) => {
    for (const tag of chain) {
      const template = catalogs[tag]?.[key];
      if (template !== undefined) return formatPackageMessage(template, params);
    }
    return key;
  };
}
