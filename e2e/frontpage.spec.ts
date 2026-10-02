import { expect, test } from '@playwright/test';

test.describe('前台页面', () => {
  test('首页渲染主题', async ({ page }) => {
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: '为可扩展业务提供稳定的运行底座' }),
    ).toBeVisible();
  });

  test('店铺页渲染服务目录', async ({ page }) => {
    await page.goto('/shop');
    await expect(page.getByRole('heading', { name: '服务目录' })).toBeVisible();
  });

  test('插件前台页面渲染', async ({ page }) => {
    await page.goto('/notice');
    await expect(page.getByRole('heading', { name: '站点公告' })).toBeVisible();
  });

  test('未匹配页面返回 404 提示', async ({ page }) => {
    await page.goto('/definitely-not-a-real-page');
    await expect(page.getByText('未找到这个页面')).toBeVisible();
  });
});
