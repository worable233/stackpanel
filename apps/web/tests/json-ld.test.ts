import { describe, expect, it } from 'vitest';
import { serializeJsonLd } from '@/components/json-ld';

/**
 * Regression for audit H-1: CMS content rendered into JSON-LD must not be able
 * to close the inline `<script>` tag and inject executable markup.
 */
describe('serializeJsonLd', () => {
  it('escapes markup that could break out of the inline script tag', () => {
    const payload = '</script><script>alert(1)</script>';
    const out = serializeJsonLd([{ headline: payload }]);

    expect(out).not.toContain('</script>');
    expect(out).not.toContain('<script>');
    expect(out).toContain('\\u003c/script\\u003e');
    // Escaping is lossless: it still parses back to the original value.
    expect(JSON.parse(out)).toEqual([{ headline: payload }]);
  });

  it('escapes ampersands and the JSON line separators', () => {
    const value = 'a&b\u2028c\u2029d';
    const out = serializeJsonLd({ a: value });

    expect(out).not.toContain('&');
    expect(out).not.toContain('\u2028');
    expect(out).not.toContain('\u2029');
    expect(JSON.parse(out)).toEqual({ a: value });
  });
});
