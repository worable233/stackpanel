import { describe, expect, it } from 'vitest';
import { mergeSeoMeta } from '@stackpanel/sdk';
import { toNextMetadata } from '@/lib/seo';

/**
 * 逐页 SEO 覆写的**前台出口**（对标 #12.4）。
 *
 * 内核 `/seo/meta` 返回合并后的元数据（见 apps/api/tests/integration/seo-pages.test.ts），
 * 站点源再把它映射成 Next 的 `Metadata` —— 这两个纯函数就是「覆写真的进了 <head>」
 * 的那一段。不测它们，就只知道接口返回了什么，不知道页面渲染成什么。
 */
describe('per-page SEO override reaches page metadata', () => {
  const origin = 'https://example.test';

  it('maps title, description and canonical from the override', () => {
    const meta = mergeSeoMeta(
      { title: 'provider 标题', description: 'provider 描述' },
      { title: '关于我们', description: '平台介绍' },
    );
    const next = toNextMetadata(meta, origin, '/about');
    expect(next.title).toBe('关于我们');
    expect(next.description).toBe('平台介绍');
    expect((next.alternates as { canonical: string }).canonical).toBe(`${origin}/about`);
  });

  it('keeps provider-only fields the editor never touches (jsonLd)', () => {
    // 逐字段覆盖的意义就在这里：改标题不该抹掉结构化数据。
    const meta = mergeSeoMeta(
      { title: '商品', jsonLd: { '@type': 'Product', name: '商品' } },
      { title: '商品（运营标题）' },
    );
    expect(meta.title).toBe('商品（运营标题）');
    expect(meta.jsonLd).toEqual({ '@type': 'Product', name: '商品' });
  });

  it('turns noindex into robots directives and leaves robots alone otherwise', () => {
    const blocked = toNextMetadata({ title: 'x', noindex: true }, origin, '/about');
    expect(blocked.robots).toEqual({ index: false, follow: false });

    // 没填 noindex = 不干预，不能静默把页面设成可索引。
    const untouched = toNextMetadata({ title: 'x' }, origin, '/about');
    expect(untouched.robots).toBeUndefined();
  });

  it('makes a relative share image absolute', () => {
    const next = toNextMetadata({ title: 'x', ogImage: '/og/about.png' }, origin, '/about');
    expect(next.openGraph?.images).toEqual([`${origin}/og/about.png`]);
  });
});
