import { expect, test } from '@playwright/test';
import { authedPage } from './session';
import { CATALOG_CHILD_NAME, CATALOG_PRODUCT_NAME, CATALOG_ROOT_NAME } from './constants';

test.describe('商品目录插件', () => {
  test('商店页展示分类树、上架商品与数量摘要', async ({ page }) => {
    await page.goto('/shop');
    await expect(page.getByRole('heading', { name: '服务目录' })).toBeVisible();
    await expect(page.getByRole('link', { name: CATALOG_ROOT_NAME })).toBeVisible();
    await expect(page.getByRole('link', { name: CATALOG_CHILD_NAME })).toBeVisible();
    await expect(page.getByRole('link', { name: CATALOG_PRODUCT_NAME })).toBeVisible();
    await expect(page.getByText('有货').first()).toBeVisible();
    await expect(page.getByText(/共 \d+ 件服务/)).toBeVisible();
  });

  test('点击分类进入分类浏览，展示面包屑并按子树过滤商品', async ({ page }) => {
    await page.goto('/shop');
    await page.getByRole('link', { name: CATALOG_ROOT_NAME }).click();
    await expect(page).toHaveURL(/\/shop\?categoryId=[0-9a-f-]{36}/);
    await expect(page.getByRole('heading', { name: CATALOG_ROOT_NAME })).toBeVisible();
    const crumb = page.getByRole('navigation', { name: '面包屑' });
    await expect(crumb).toBeVisible();
    await expect(crumb.getByRole('link', { name: '全部服务' })).toHaveAttribute('href', '/shop');
    await expect(crumb.getByText(CATALOG_ROOT_NAME, { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: CATALOG_PRODUCT_NAME })).toBeVisible();
  });

  test('商品卡片跳转商店详情页', async ({ page }) => {
    await page.goto('/shop');
    await page.getByRole('link', { name: CATALOG_PRODUCT_NAME }).click();
    await expect(page).toHaveURL(/\/shop\/[0-9a-z-]{20,}/);
  });

  test('管理员可在插件目录页管理分类', async ({ page }) => {
    await authedPage(page);
    await page.goto('/admin/plugin/catalog/categories');
    await expect(page.getByRole('heading', { name: '商品目录' })).toBeVisible();
    await expect(page.getByRole('button', { name: '创建分类' })).toBeVisible();
    await expect(page.locator('p', { hasText: CATALOG_ROOT_NAME })).toBeVisible();
    await expect(page.getByRole('button', { name: '保存修改' }).first()).toBeVisible();
  });
});
