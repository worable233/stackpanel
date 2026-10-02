import { expect, test } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_PASSWORD, USER_EMAIL, USER_PASSWORD } from './constants';
import { login } from './helpers';

test.describe('登录', () => {
  test('错误密码提示登录失败', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('邮箱').fill(ADMIN_EMAIL);
    await page.getByLabel('密码').fill('wrong-password');
    await page.getByRole('button', { name: '登录' }).click();
    await expect(page.getByText('邮箱或密码错误')).toBeVisible();
  });

  test('管理员登录后进入工作台', async ({ page }) => {
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible();
  });

  test('普通用户登录后进入账户中心', async ({ page }) => {
    await login(page, USER_EMAIL, USER_PASSWORD);
    await expect(page).toHaveURL(/\/account/);
    await expect(page.getByText('账户中心')).toBeVisible();
  });
});
