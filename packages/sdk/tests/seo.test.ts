import { describe, expect, it } from 'vitest';
import {
  dedupeSeoUrlEntries,
  defineSeoProvider,
  isSeoProvider,
  mergeSeoMeta,
  normalizeSeoPath,
  seoAlternatesToLanguages,
  toAbsoluteUrl,
  type SeoProvider,
  type SeoSitemapEntry,
} from '../src/seo.js';

describe('normalizeSeoPath', () => {
  it('adds a leading slash and strips trailing slashes', () => {
    expect(normalizeSeoPath('blog/hello')).toBe('/blog/hello');
    expect(normalizeSeoPath('/blog/hello/')).toBe('/blog/hello');
    expect(normalizeSeoPath('  /blog/hello/  ')).toBe('/blog/hello');
  });

  it('keeps the root path as a single slash', () => {
    expect(normalizeSeoPath('/')).toBe('/');
    expect(normalizeSeoPath('')).toBe('/');
  });
});

describe('toAbsoluteUrl', () => {
  it('joins a site-relative path onto the origin', () => {
    expect(toAbsoluteUrl('https://example.com', '/blog/hello')).toBe(
      'https://example.com/blog/hello',
    );
    expect(toAbsoluteUrl('https://example.com/', 'blog/hello')).toBe(
      'https://example.com/blog/hello',
    );
  });

  it('returns an already-absolute URL unchanged', () => {
    expect(toAbsoluteUrl('https://example.com', 'https://cdn.example.com/a')).toBe(
      'https://cdn.example.com/a',
    );
  });
});

describe('seoAlternatesToLanguages', () => {
  it('maps hreflang alternates into a language record', () => {
    expect(
      seoAlternatesToLanguages([
        { hreflang: 'zh-CN', href: '/blog/a' },
        { hreflang: 'en-US', href: '/blog/a-en' },
        { hreflang: 'x-default', href: '/blog/a' },
      ]),
    ).toEqual({ 'zh-CN': '/blog/a', 'en-US': '/blog/a-en', 'x-default': '/blog/a' });
  });

  it('ignores empty entries and tolerates undefined', () => {
    expect(seoAlternatesToLanguages(undefined)).toEqual({});
    expect(seoAlternatesToLanguages([{ hreflang: '', href: '/a' }])).toEqual({});
  });
});

describe('dedupeSeoUrlEntries', () => {
  const entry = (url: string, source: string): SeoSitemapEntry => ({ url, source });

  it('keeps the first contributor and drops later duplicates', () => {
    const result = dedupeSeoUrlEntries([
      entry('/blog/a', 'cms'),
      entry('/blog/b', 'cms'),
      entry('/blog/a', 'other'),
    ]);
    expect(result.map((e) => e.source)).toEqual(['cms', 'cms']);
    expect(result.map((e) => e.url)).toEqual(['/blog/a', '/blog/b']);
  });

  it('treats trailing-slash variants as the same URL', () => {
    const result = dedupeSeoUrlEntries([entry('/blog/a', 'cms'), entry('/blog/a/', 'other')]);
    expect(result).toHaveLength(1);
    expect(result[0]?.source).toBe('cms');
  });
});

describe('mergeSeoMeta', () => {
  it('applies non-empty override fields over the base', () => {
    const merged = mergeSeoMeta(
      { title: '基础标题', description: '基础描述', canonical: '/a' },
      { title: '覆盖标题', canonical: '/b' },
    );
    expect(merged).toEqual({ title: '覆盖标题', description: '基础描述', canonical: '/b' });
  });

  it('replaces jsonLd wholesale rather than concatenating', () => {
    const merged = mergeSeoMeta(
      { jsonLd: { '@type': 'WebPage' } },
      { jsonLd: { '@type': 'BlogPosting' } },
    );
    expect(merged.jsonLd).toEqual({ '@type': 'BlogPosting' });
  });

  it('returns the base untouched when the override is null', () => {
    const base = { title: '基础标题' };
    expect(mergeSeoMeta(base, null)).toEqual(base);
  });

  it('keeps boolean false as an explicit override', () => {
    expect(mergeSeoMeta({ noindex: true }, { noindex: false })).toEqual({ noindex: false });
  });
});

describe('isSeoProvider', () => {
  const base: SeoProvider = {
    id: 'cms',
    async listEntries() {
      return { entries: [], total: 0 };
    },
  };

  it('accepts a minimal provider', () => {
    expect(isSeoProvider(base)).toBe(true);
    expect(isSeoProvider(defineSeoProvider(base))).toBe(true);
  });

  it('rejects values missing an id or listEntries', () => {
    expect(isSeoProvider(null)).toBe(false);
    expect(isSeoProvider({})).toBe(false);
    expect(isSeoProvider({ id: '', listEntries: async () => ({ entries: [], total: 0 }) })).toBe(
      false,
    );
    expect(isSeoProvider({ id: 'x' })).toBe(false);
  });

  it('rejects a provider whose optional hooks are not functions', () => {
    expect(isSeoProvider({ ...base, listFeed: 'nope' })).toBe(false);
    expect(isSeoProvider({ ...base, resolveMeta: 42 })).toBe(false);
  });
});
