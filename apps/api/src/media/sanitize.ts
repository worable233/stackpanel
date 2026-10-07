/**
 * Rich-text sanitizer (ADR-0014 §5) — thin re-export.
 *
 * The canonical allowlist policy lives in `@stackpanel/sdk` (`src/sanitize.ts`)
 * so plugins and the kernel share exactly one implementation. This module keeps
 * the kernel's import path stable and documents why sanitizing happens on write.
 *
 * The contract is "stored content is already sanitized": a plugin sanitizes raw
 * HTML with `sanitizeRichText` before persisting it, and renderers may then
 * trust the stored value. Plugins must not bypass this.
 */
export { isSafeUrl } from '@stackpanel/sdk';
export { sanitizeRichText, type SanitizeOptions } from '@stackpanel/sdk/sanitize';
