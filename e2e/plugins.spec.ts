import { expect, test } from '@playwright/test';
import { authedPage } from './session';

test.describe('插件管理', () => {
  test('插件列表展示已安装插件', async ({ page }) => {
    await authedPage(page);
    await page.goto('/admin/plugins');
    await expect(page.getByRole('heading', { name: '插件管理' })).toBeVisible();
    for (const name of ['Hello 插件', '商店插件', '站点公告']) {
      await expect(page.locator('li', { hasText: name }).first()).toBeVisible();
    }
  });

  test('启用/停用插件即时生效', async ({ page }) => {
    await authedPage(page);
    await page.goto('/admin/plugins');

    const item = page.locator('li', { hasText: 'Hello 插件' });
    await expect(item).toBeVisible();
    const wasEnabled = (await item.getByText(/已启用|已停用/).textContent()) === '已启用';

    await item.getByRole('button', { name: wasEnabled ? '停用' : '启用' }).click();
    await expect(item.getByText(wasEnabled ? '已停用' : '已启用')).toBeVisible();

    await item.getByRole('button', { name: wasEnabled ? '启用' : '停用' }).click();
    await expect(item.getByText(wasEnabled ? '已启用' : '已停用')).toBeVisible();
  });

  test('插件详情页展示扩展点与权限', async ({ page }) => {
    await authedPage(page);
    await page.goto('/admin/plugins/hello');
    await expect(page.getByRole('heading', { name: 'Hello 插件' })).toBeVisible();
    await expect(page.getByText('扩展点')).toBeVisible();
    await expect(page.getByRole('heading', { name: '权限' })).toBeVisible();
    await expect(page.getByText('前端页面')).toBeVisible();
  });
});
