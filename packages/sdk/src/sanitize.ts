/**
 * Server-side rich-text sanitizer (ADR-0014 §5).
 *
 * The contract is "stored content is already sanitized": plugins hand raw HTML
 * to this function *before* it is persisted, and renderers may then trust it.
 * Sanitizing on read is explicitly rejected in the ADR because every render
 * path would have to remember to do it. Exported from the SDK so every plugin
 * shares one implementation and the kernel never re-implements the policy.
 *
 * The policy is an allowlist of elements and attributes. Anything not on the
 * list is dropped: the tag markers are removed but the textual content is kept,
 * so a stray `<custom-widget>` never breaks the surrounding prose. Event
 * handler attributes, `<script>`/`<style>` and friends, and unsafe URL schemes
 * (`javascript:`, `data:` outside inline images) are removed outright.
 */

/** Elements whose entire subtree is discarded, not just their tags. */
const DROP_ELEMENTS = [
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'link',
  'meta',
  'base',
  'noscript',
  'template',
  'svg',
  'math',
  'canvas',
];

/** Elements whose tags (and allowed attributes) are preserved. */
const ALLOWED_TAGS = new Set([
  'p',
  'br',
  'hr',
  'div',
  'span',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'del',
  'ins',
  'mark',
  'small',
  'sub',
  'sup',
  'blockquote',
  'code',
  'pre',
  'kbd',
  'samp',
  'var',
  'abbr',
  'cite',
  'q',
  'time',
  'a',
  'img',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'table',
  'caption',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'figure',
  'figcaption',
  'details',
  'summary',
]);

/** Attributes allowed on any element. */
const GLOBAL_ATTRS = new Set(['class', 'title', 'dir', 'lang', 'role']);

/** Extra attributes allowed only on specific elements. */
const TAG_ATTRS: Record<string, ReadonlySet<string>> = {
  a: new Set(['href', 'target', 'rel']),
  img: new Set(['src', 'alt', 'width', 'height', 'loading', 'decoding']),
  ol: new Set(['start', 'type']),
  td: new Set(['colspan', 'rowspan', 'headers']),
  th: new Set(['colspan', 'rowspan', 'scope', 'headers']),
  time: new Set(['datetime']),
  q: new Set(['cite']),
  blockquote: new Set(['cite']),
};

/** Attributes whose value is a URL and must pass {@link isSafeUrl}. */
const URL_ATTRS = new Set(['href', 'src', 'cite']);

/** Attributes whose value must be an integer (or nothing). */
const NUMERIC_ATTRS = new Set(['width', 'height', 'colspan', 'rowspan', 'start']);

export interface SanitizeOptions {
  /** Allow `data:image/*;base64,...` inside `src`. Off by default. */
  allowInlineImages?: boolean;
}

export function sanitizeRichText(raw: string, options: SanitizeOptions = {}): string {
  if (!raw) return '';
  // 1. Drop comments and dangerous elements (including their content).
  let html = raw.replace(/<!--[\s\S]*?-->/g, '');
  for (const tag of DROP_ELEMENTS) {
    const paired = new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}\\s*>`, 'gi');
    const selfClosing = new RegExp(`<${tag}\\b[^>]*/?>`, 'gi');
    html = html.replace(paired, '').replace(selfClosing, '');
  }

  // 2. Walk the remaining tags; keep allowed ones (attributes filtered), drop
  //    the markers of the rest while preserving their text content.
  const tagPattern = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)\/?>/g;
  let out = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(html)) !== null) {
    out += escapeBareLt(html.slice(lastIndex, match.index));
    lastIndex = tagPattern.lastIndex;

    const full = match[0];
    const name = (match[1] as string).toLowerCase();
    const isClosing = full.startsWith('</');
    if (!ALLOWED_TAGS.has(name)) continue; // drop marker, keep text

    if (isClosing) {
      out += `</${name}>`;
      continue;
    }
    const attrs = sanitizeAttributes(name, match[2] ?? '', options);
    const selfClose = name === 'br' || name === 'hr' || name === 'img';
    out += `<${name}${attrs}${selfClose ? ' /' : ''}>`;
  }
  out += escapeBareLt(html.slice(lastIndex));
  return out;
}

function sanitizeAttributes(name: string, rawAttrs: string, options: SanitizeOptions): string {
  const declared = TAG_ATTRS[name] ?? new Set<string>();
  const attrPattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  const kept: Array<[string, string | null]> = [];
  let match: RegExpExecArray | null;
  while ((match = attrPattern.exec(rawAttrs)) !== null) {
    const attr = (match[1] as string).toLowerCase();
    if (attr.startsWith('on') || attr === 'style' || attr === 'srcdoc') continue;
    if (!GLOBAL_ATTRS.has(attr) && !declared.has(attr)) continue;
    const value = (match[2] ?? match[3] ?? match[4] ?? null) as string | null;

    if (value !== null) {
      if (
        URL_ATTRS.has(attr) &&
        !isSafeUrl(value, attr === 'src' && options.allowInlineImages === true)
      ) {
        continue;
      }
      if (NUMERIC_ATTRS.has(attr) && !/^\d{1,6}$/.test(value.trim())) continue;
    }
    kept.push([attr, value]);
  }

  let result = '';
  let hasBlankTarget = false;
  for (const [attr, value] of kept) {
    if (name === 'a' && attr === 'target') {
      if (value !== '_blank') continue;
      hasBlankTarget = true;
    }
    result += value === null ? ` ${attr}` : ` ${attr}="${escapeAttr(value)}"`;
  }
  // Force a safe rel whenever an anchor opens a new tab.
  if (name === 'a' && hasBlankTarget) {
    result += ' rel="noopener noreferrer"';
  }
  return result;
}

/** URL allowlist: same-origin paths, fragments, and a few safe schemes. */
export function isSafeUrl(value: string, allowInlineImage = false): boolean {
  // Strip C0 control characters and whitespace that can smuggle a scheme
  // (`java\tscript:`), matching how browsers normalise URLs.
  // eslint-disable-next-line no-control-regex -- C0 controls are the attack vector here
  const compact = value.replace(/[\u0000-\u0020\u007f]+/g, '');
  if (compact.length === 0) return false;
  if (compact.startsWith('#')) return true;
  if (compact.startsWith('//')) return false; // scheme-relative, not same-origin
  if (compact.startsWith('/')) return true;
  if (/^(https?:|mailto:|tel:)/i.test(compact)) return true;
  if (allowInlineImage && /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(compact)) {
    return true;
  }
  // No scheme at all → a relative path such as `images/a.png`.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(compact)) return true;
  return false;
}

/** Escape a `&`/`<` that is not part of a recognised tag, so text cannot break out. */
function escapeBareLt(text: string): string {
  return text.replace(/</g, '&lt;');
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
