import { describe, expect, it } from 'vitest';
import type { NavItem } from '@stackpanel/sdk';
import {
  applyNavEntries,
  applyNavEntriesIncludingHidden,
  normalizeNavHref,
  normalizeNavLabel,
  type NavEntryRecord,
} from '../../src/lib/nav-entries.ts';

const base: NavItem[] = [
  { surface: 'admin', label: '工作台', href: '/admin' },
  { surface: 'admin', label: '用户管理', href: '/admin/users' },
  { surface: 'admin', label: '审计日志', href: '/admin/audit' },
];

function entry(partial: Partial<NavEntryRecord> & { href: string }): NavEntryRecord {
  return {
    id: `id-${partial.href}`,
    surface: 'admin',
    label: null,
    sortOrder: null,
    hidden: false,
    custom: false,
    updatedAt: new Date(0),
    ...partial,
  };
}

/** 菜单覆写是纯展示逻辑，所以能在没有数据库的情况下把这些边界钉死。 */
describe('applyNavEntries', () => {
  it('keeps the default order when nothing is overridden', () => {
    expect(applyNavEntries(base, [], 'admin').map((item) => item.href)).toEqual([
      '/admin',
      '/admin/users',
      '/admin/audit',
    ]);
  });

  it('applies sort order, renamed labels and hiding', () => {
    const items = applyNavEntries(
      base,
      [
        entry({ href: '/admin/audit', sortOrder: 0, label: '操作记录' }),
        entry({ href: '/admin', hidden: true }),
      ],
      'admin',
    );
    expect(items.map((item) => item.label)).toEqual(['操作记录', '用户管理']);
    expect(items[0]?.custom).toBe(false);
  });

  it('appends custom links after default items', () => {
    const items = applyNavEntries(
      base,
      [entry({ href: 'https://docs.example.com', label: '帮助文档', sortOrder: 3, custom: true })],
      'admin',
    );
    expect(items.at(-1)).toMatchObject({ href: 'https://docs.example.com', custom: true });
  });

  it('ignores overrides whose default item disappeared (plugin uninstalled)', () => {
    const items = applyNavEntries(
      base,
      [entry({ href: '/admin/gone', label: '已卸载插件', sortOrder: 0 })],
      'admin',
    );
    // 不被当成自定义项补回来：它不是运营加的。
    expect(items.map((item) => item.href)).toEqual(['/admin', '/admin/users', '/admin/audit']);
  });

  it('exposes hidden items to the admin view but not to the public menu', () => {
    const entries = [entry({ href: '/admin/users', hidden: true })];
    expect(applyNavEntries(base, entries, 'admin').map((item) => item.href)).not.toContain(
      '/admin/users',
    );
    const adminView = applyNavEntriesIncludingHidden(base, entries, 'admin');
    expect(adminView.map((item) => item.href)).toEqual(['/admin', '/admin/users', '/admin/audit']);
    expect(adminView[1]?.hidden).toBe(true);
  });
});

describe('normalizeNavHref', () => {
  it('accepts site paths and http(s) urls', () => {
    expect(normalizeNavHref('/admin/users')).toBe('/admin/users');
    expect(normalizeNavHref('https://docs.example.com/x')).toBe('https://docs.example.com/x');
  });

  it('rejects protocol-relative and non-http schemes', () => {
    // `//evil.com` 看起来像站内路径，实际是外链。
    expect(normalizeNavHref('//evil.com')).toBeNull();
    expect(normalizeNavHref('javascript:alert(1)')).toBeNull();
    expect(normalizeNavHref('ftp://example.com')).toBeNull();
    expect(normalizeNavHref(' admin')).toBeNull();
    expect(normalizeNavHref('admin')).toBeNull();
  });

  it('requires a label to survive trimming', () => {
    expect(normalizeNavLabel('  帮助  ')).toBe('帮助');
    expect(normalizeNavLabel('   ')).toBeNull();
  });
});
