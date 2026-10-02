import { expect, test } from '@playwright/test';
import { authedPage } from './session';

test.describe('审计日志', () => {
  test('按操作类型过滤审计日志', async ({ page }) => {
    await authedPage(page);
    await page.goto('/admin/audit');
    await expect(page.getByRole('heading', { name: '审计日志' })).toBeVisible();

    await page.getByLabel('操作', { exact: true }).fill('plugin.install');
    await page.getByRole('button', { name: '查询' }).click();
    await expect(page).toHaveURL(/action=plugin\.install/);
    await expect(page.getByText('安装插件').first()).toBeVisible();
  });

  test('无匹配结果时显示空状态', async ({ page }) => {
    await authedPage(page);
    await page.goto('/admin/audit?action=no.such.action');
    await expect(page.getByText('暂无记录。')).toBeVisible();
  });
});
