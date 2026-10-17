import { describe, expect, it } from 'vitest';
import {
  groupBackendNavigation,
  isBackendOverview,
  resolveBackendActiveItem,
} from '@/lib/backend-navigation';

const items = [
  { href: '/admin', label: '工作台' },
  {
    href: '/admin/plugin/store/products',
    label: '商品',
    group: '商店',
    order: 10,
    activePaths: ['/admin/plugin/store/edit'],
  },
  { href: '/admin/plugin/store/overview', label: '概览', group: '商店', order: 0 },
  { href: '/admin/plugin/catalog/categories', label: '分类', group: '商店', order: 20 },
  { href: '/admin/plugin/custom/settings', label: '配置', group: '自定义功能' },
];

describe('plugin-owned backend navigation', () => {
  it('recognizes overview entries consistently without matching unrelated pages', () => {
    for (const label of ['概览', '费用概览', '账户概览', 'Overview']) {
      expect(isBackendOverview({ href: '/account/billing', label })).toBe(true);
    }
    expect(isBackendOverview({ href: '/admin/plugin/store/overview', label: '商店' })).toBe(true);
    expect(isBackendOverview({ href: '/account/balance', label: '充值' })).toBe(false);
    expect(isBackendOverview({ href: '/account/services', label: '服务' })).toBe(false);
  });
  it('combines related plugins without discarding arbitrary groups', () => {
    const groups = groupBackendNavigation(items);
    expect([...groups.keys()]).toEqual(['商店', '自定义功能']);
    expect(groups.get('商店')?.map((item) => item.label)).toEqual(['概览', '商品', '分类']);
    expect(items[1]?.label).toBe('商品');
  });
  it('selects declared owners of hidden editors and nested product routes', () => {
    for (const path of ['/admin/plugin/store/edit/id', '/admin/plugin/store/products/new']) {
      expect(resolveBackendActiveItem(path, items, '/admin')?.label).toBe('商品');
    }
  });
  it('uses the most specific route and never guesses unrelated ownership', () => {
    expect(
      resolveBackendActiveItem(
        '/admin/plugin/store/products/new',
        [...items, { href: '/admin/plugin/store/products/new', label: '新建' }],
        '/admin',
      )?.label,
    ).toBe('新建');
    expect(
      resolveBackendActiveItem('/admin/plugin/store/products-extra', items, '/admin'),
    ).toBeNull();
    expect(resolveBackendActiveItem('/admin/unknown', items, '/admin')).toBeNull();
    expect(resolveBackendActiveItem('/admin', items, '/admin')?.label).toBe('工作台');
  });
  it('does not synthesize an overview when its provider is absent', () => {
    const remaining = items.filter((item) => !item.href.includes('/store/'));
    expect(
      groupBackendNavigation(remaining)
        .get('商店')
        ?.map((item) => item.label),
    ).toEqual(['分类']);
    expect(
      resolveBackendActiveItem('/admin/plugin/store/overview', remaining, '/admin'),
    ).toBeNull();
  });
});
