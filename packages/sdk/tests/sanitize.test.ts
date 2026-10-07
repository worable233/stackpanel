import { describe, expect, it } from 'vitest';
import { isSafeUrl, sanitizeRichText } from '../src/sanitize.js';

describe('sanitizeRichText', () => {
  it('keeps allowed formatting and links', () => {
    const input =
      '<p>Hello <strong>world</strong> <a href="https://example.com" target="_blank">link</a></p>';
    const out = sanitizeRichText(input);
    expect(out).toContain('<strong>world</strong>');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it('drops script/style elements and their content', () => {
    const out = sanitizeRichText('<p>a</p><script>alert(1)</script><style>p{}</style><p>b</p>');
    expect(out).toBe('<p>a</p><p>b</p>');
    expect(out).not.toContain('alert');
  });

  it('removes inline event handlers and style attributes', () => {
    const out = sanitizeRichText('<img src="/a.png" onerror="alert(1)" style="x" />');
    expect(out).not.toContain('onerror');
    expect(out).not.toContain('style=');
    expect(out).toContain('src="/a.png"');
  });

  it('strips javascript: and data: URLs but keeps inline images when opted in', () => {
    expect(sanitizeRichText('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitizeRichText('<a href="java\tscript:alert(1)">x</a>')).toBe('<a>x</a>');
    const withData = sanitizeRichText('<img src="data:image/png;base64,AAAA" />', {
      allowInlineImages: true,
    });
    expect(withData).toContain('data:image/png;base64,AAAA');
    const withoutData = sanitizeRichText('<img src="data:image/png;base64,AAAA" />');
    expect(withoutData).not.toContain('data:');
  });

  it('preserves text content of unknown elements but drops their tags', () => {
    const out = sanitizeRichText('<custom-widget data-x="1">kept</custom-widget>');
    expect(out).toBe('kept');
  });

  it('never emits a bare < from untrusted text', () => {
    // A `<` that does not begin a real tag must not survive as markup. The
    // parser either escapes it or drops the bogus tag, so the output must never
    // contain a raw `<` other than a real allowed tag.
    expect(sanitizeRichText('a < b')).not.toMatch(/<(?!\/?(p|br|div|span)\b)/);
    expect(sanitizeRichText('a </ b')).not.toMatch(/<(?!\/?(p|br|div|span)\b)/);
    expect(sanitizeRichText('a < b')).toContain('&lt;');
  });

  it('drops comments', () => {
    expect(sanitizeRichText('<p>a<!-- secret -->b</p>')).toBe('<p>ab</p>');
  });

  it('drops numeric attributes that are not numeric', () => {
    expect(sanitizeRichText('<img src="/a.png" width="100" height="abc" />')).toBe(
      '<img src="/a.png" width="100" />',
    );
  });

  it('rejects target values other than _blank and forces rel', () => {
    const out = sanitizeRichText('<a href="/x" target="_self">x</a>');
    expect(out).not.toContain('target');
    expect(out).toBe('<a href="/x">x</a>');
  });

  it('handles empty input', () => {
    expect(sanitizeRichText('')).toBe('');
  });

  it('keeps tables and list attributes', () => {
    const out = sanitizeRichText('<table><tr><td colspan="2">x</td></tr></table>');
    expect(out).toBe('<table><tr><td colspan="2">x</td></tr></table>');
  });
});

describe('isSafeUrl', () => {
  it('allows relative, fragment, http(s), mailto and tel', () => {
    for (const url of ['/a', '#x', 'https://x.com', 'http://x.com', 'mailto:a@b.c', 'tel:123']) {
      expect(isSafeUrl(url)).toBe(true);
    }
  });

  it('rejects protocol-relative, javascript:, data: and control-char smuggling', () => {
    for (const url of [
      '//evil.com',
      'javascript:alert(1)',
      'data:text/html,x',
      'java\nscript:x',
      '',
    ]) {
      expect(isSafeUrl(url)).toBe(false);
    }
  });
});
