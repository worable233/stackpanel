/**
 * Server-side rich-text sanitizer (ADR-0014 §5).
 *
 * The contract is "stored content is already sanitized": plugins hand raw HTML
 * to this function *before* it is persisted, and renderers may then trust it.
 * Sanitizing on read is explicitly rejected in the ADR because every render
 * path would have to remember to do it. Exported from the SDK so every plugin
 * shares one implementation and the kernel never re-implements the policy.
 *
 * The allowlist policy is expressed as configuration for the battle-tested
 * `sanitize-html` parser (SECURITY-AUDIT-2026-10-04 I-1). Anything not
 * allowlisted has its tag markers removed but its text content preserved, so a
 * stray `<custom-widget>` never breaks the surrounding prose; `<script>`,
 * `<style>` and friends are dropped with their content; event handlers and
 * unsafe URL schemes (`javascript:`, `data:` outside inline images) are
 * removed outright.
 */

import sanitizeHtml from 'sanitize-html';
import { isSafeUrl } from './url-safety.js';

export { isSafeUrl } from './url-safety.js';

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
const ALLOWED_TAGS = [
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
];

/** Attributes allowed on any element. */
const GLOBAL_ATTRS = ['class', 'title', 'dir', 'lang', 'role'];

/** Extra attributes allowed only on specific elements. */
const TAG_ATTRS: Record<string, string[]> = {
  a: ['href', 'target', 'rel'],
  img: ['src', 'alt', 'width', 'height', 'loading', 'decoding'],
  ol: ['start', 'type'],
  td: ['colspan', 'rowspan', 'headers'],
  th: ['colspan', 'rowspan', 'scope', 'headers'],
  time: ['datetime'],
  q: ['cite'],
  blockquote: ['cite'],
};

/** Attributes whose value is a URL and must pass {@link isSafeUrl}. */
const URL_ATTRS = new Set(['href', 'src', 'cite']);

/** Attributes whose value must be an integer (or nothing). */
const NUMERIC_ATTRS = new Set(['width', 'height', 'colspan', 'rowspan', 'start']);

/**
 * Drop active-content elements entirely — `sanitize-html` discards a tag's
 * contents only for tags listed in its `nonTextTags` (default excludes them
 * anyway; listed explicitly so the intent survives dependency upgrades).
 */
const NON_TEXT_TAGS = DROP_ELEMENTS.filter(
  (tag) => tag !== 'input' && tag !== 'link' && tag !== 'meta' && tag !== 'base',
);

export interface SanitizeOptions {
  /** Allow `data:image/*;base64,...` inside `src`. Off by default. */
  allowInlineImages?: boolean;
}

export function sanitizeRichText(raw: string, options: SanitizeOptions = {}): string {
  if (!raw) return '';
  return sanitizeHtml(raw, {
    allowedTags: ALLOWED_TAGS,
    nonTextTags: NON_TEXT_TAGS,
    // Unknown tags are removed but their text is kept, matching the historical
    // "drop the marker, preserve the prose" behaviour.
    disallowedTagsMode: 'discard',
    allowedAttributes: {
      '*': GLOBAL_ATTRS,
      ...TAG_ATTRS,
    },
    // Only the three URL-bearing attributes are scheme-checked; everything else
    // keeps its literal value.
    allowedSchemesAppliedToAttributes: [...URL_ATTRS],
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    // Relative (`/x`, `images/a.png`) and fragment (`#x`) URLs stay same-origin.
    allowProtocolRelative: false,
    // Never allow `data:` broadly; the option re-enables it for images only.
    allowedSchemesByTag: options.allowInlineImages ? { img: ['http', 'https', 'data'] } : {},
    // `transformTags` runs after parsing: it enforces numeric attributes, the
    // `_blank`-only target rule, and the forced `rel="noopener noreferrer"`.
    transformTags: buildTransformTags(options),
  });
}

function buildTransformTags(options: SanitizeOptions): Record<string, sanitizeHtml.Transformer> {
  const transform: Record<string, sanitizeHtml.Transformer> = {};
  for (const [tag, declared] of Object.entries(TAG_ATTRS)) {
    transform[tag] = (tagName, attribs) => {
      const next: Record<string, string> = {};
      for (const [attr, value] of Object.entries(attribs)) {
        const lower = attr.toLowerCase();
        if (!GLOBAL_ATTRS.includes(lower) && !declared.includes(lower)) continue;
        if (URL_ATTRS.has(lower)) {
          const inlineImage = lower === 'src' && options.allowInlineImages === true;
          if (value === '' || !isSafeUrl(value, inlineImage)) continue;
        }
        if (NUMERIC_ATTRS.has(lower) && !/^\d{1,6}$/.test(value.trim())) continue;
        next[lower] = value;
      }
      if (tagName === 'a') {
        // A safe `rel` is forced for any new-tab link; other targets are dropped.
        if (next['target'] !== '_blank') delete next['target'];
        if (next['target'] === '_blank') next['rel'] = 'noopener noreferrer';
      }
      return { tagName, attribs: next };
    };
  }
  return transform;
}
