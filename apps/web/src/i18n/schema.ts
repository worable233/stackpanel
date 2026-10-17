/**
 * Message contract for the interface catalogs (ADR-0016 §2, PLAN-i18n-completion §3 阶段 0).
 *
 * These rules are language-independent and shared by the scanner, the catalog
 * tests and any tooling that authors messages. They exist so a "稳定 message
 * id" is a checkable property rather than a convention: keys have a namespace,
 * placeholders must agree across locales, and language tags must be real BCP 47.
 */

/** Locale tag shape per BCP 47: `language[-script][-region][-variant…]`. */
const BCP47 = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/;

/** A dotted message id: lowercase namespace root + dotted camel/snake segments. */
const MESSAGE_KEY = /^[a-z][a-zA-Z0-9-]*(\.[a-zA-Z0-9_][a-zA-Z0-9_-]*)+$/;

/**
 * Namespaces that belong to the kernel.
 *
 * These are **kernel-only** names. A package catalog is resolved inside that
 * package and is never merged into the kernel catalog (ADR-0016 §5), so it may
 * legitimately use `nav.*` / `error.*` without shadowing anything — there is no
 * shared map to collide with. This list is the guard for any hypothetical
 * merge-based host; `apps/web/src/i18n/package-messages.ts` deliberately does
 * not apply it.
 */
export const RESERVED_NAMESPACES = [
  'common',
  'nav',
  'auth',
  'error',
  'locale',
  'notification',
] as const;

/** True when `tag` is a syntactically valid BCP 47 language tag. */
export function isValidLanguageTag(tag: string): boolean {
  return BCP47.test(tag);
}

/** True when `key` is a valid dotted message id. */
export function isValidMessageKey(key: string): boolean {
  return MESSAGE_KEY.test(key);
}

/** The namespace (first segment) of a dotted message id. */
export function messageNamespace(key: string): string {
  return key.split('.')[0] ?? key;
}

/**
 * True when `key` may be defined by a dynamic package. Kernel namespaces are
 * reserved so a package cannot shadow platform copy.
 */
export function isPackageMessageKey(key: string): boolean {
  return !(RESERVED_NAMESPACES as readonly string[]).includes(messageNamespace(key));
}

/** The set of `{name}` placeholders used by `template`, sorted for comparison. */
export function placeholderNames(template: string): string[] {
  const names = new Set<string>();
  const pattern = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(template)) !== null) names.add(match[1]!);
  return [...names].sort();
}

/**
 * Compare the placeholders of two locale variants of the same message.
 * Returns `null` when they agree, otherwise a human-readable difference.
 */
export function placeholderDiff(a: string, b: string): string | null {
  const left = placeholderNames(a);
  const right = placeholderNames(b);
  if (left.length === right.length && left.every((name, i) => name === right[i])) {
    return null;
  }
  return `placeholders differ: {${left.join(',')}} vs {${right.join(',')}}`;
}
