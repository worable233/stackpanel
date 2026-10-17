import { expect, type Page } from '@playwright/test';

/** Log in through the web UI and wait for the redirect to finish. */
export async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('邮箱').fill(email);
  // The password field has a "show password" toggle with an aria-label that also
  // contains 密码, so target the input by role/name explicitly.
  await page.getByRole('textbox', { name: '密码' }).fill(password);
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 });
}
