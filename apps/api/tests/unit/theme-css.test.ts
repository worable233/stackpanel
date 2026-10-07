import { describe, expect, it } from 'vitest';
import { validateThemeCss } from '../../src/lib/themes.ts';

/**
 * SECURITY-AUDIT-2026-10-04 I-1: theme CSS is validated by parsing the file with
 * `css-tree` instead of matching hand-rolled regexes. These tests pin the
 * allowlist (only `:root`/`.dark`, only `--*` declarations) and the rejection of
 * constructs that could smuggle code (`@` rules, `url()`, backslash escapes).
 */
describe('validateThemeCss (css-tree)', () => {
  it('accepts token-only :root and .dark blocks', () => {
    expect(validateThemeCss(':root { --background: oklch(1 0 0); }')).toBe(true);
    expect(
      validateThemeCss(':root { --background: oklch(1 0 0); } .dark { --background: #000; }'),
    ).toBe(true);
    expect(validateThemeCss('.dark{--a:red;}')).toBe(true);
    expect(validateThemeCss('')).toBe(true);
  });

  it('rejects any non-token selector', () => {
    expect(validateThemeCss(':root { --x: 1; } .evil { color: red; }')).toBe(false);
    expect(validateThemeCss('body { --x: 1; }')).toBe(false);
  });

  it('rejects non-custom-property declarations', () => {
    expect(validateThemeCss(':root { color: red; }')).toBe(false);
    expect(validateThemeCss(':root { --ok: 1; color: red; }')).toBe(false);
  });

  it('rejects at-rules', () => {
    expect(validateThemeCss('@media print { :root { --x: 1; } }')).toBe(false);
    expect(validateThemeCss('@import "x.css";')).toBe(false);
  });

  it('rejects url() and backslash-escaped obfuscation', () => {
    expect(validateThemeCss(':root { --x: url(//evil.example/x); }')).toBe(false);
    expect(validateThemeCss(":root { --img: '\\75 rl(x)'; }")).toBe(false);
  });

  it('rejects malformed input', () => {
    expect(validateThemeCss(':root { --x: ')).toBe(false);
  });
});
