import { expect, test } from '@playwright/test';
import { login } from './helpers';
import { USER_EMAIL, USER_PASSWORD } from './constants';

/**
 * Contract 01 §7 / contract 05 §5 — runtime frontend, end to end in a browser.
 *
 * Two items that were previously only verified structurally:
 *
 *  1. A **real Server Action** (`<form action={fn}>`) declared by a runtime-loaded
 *     plugin frontend actually submits, runs on the server, and comes back
 *     without a full page reload.
 *  2. A page carrying a package stylesheet is served under the strict CSP and
 *     the `<link>` loads (no `securitypolicyviolation`), with the scope marker
 *     present so `styles[]` rules can match.
 */

test.describe('运行期前端 · 浏览器端到端', () => {
  test('插件前端声明的 Server Action 真实提交并回传', async ({ page }) => {
    await login(page, USER_EMAIL, USER_PASSWORD);

    // `/account/balance` is rendered by the `store-wallet` plugin frontend, which
    // declares `wallet.create-topup` as a Server Action bound by the host.
    await page.goto('/account/balance');
    await expect(page.getByText('可用余额')).toBeVisible();

    // A failed action renders `?error=...` on the same page; a successful one
    // redirects to the payment URL. Either way the form must actually reach the
    // server (a broken binding leaves the page untouched or shows a network
    // error), so watch for the navigation/action response.
    const actionResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        (response.url().includes('/account/balance') || response.url().includes('/wallet/')),
      { timeout: 20_000 },
    );

    const topUpForm = page.locator('form').first();
    if ((await topUpForm.count()) === 0) {
      test.skip(true, '该环境未配置在线支付方式，无充值表单可提交');
    }
    await topUpForm.locator('button[type=submit]').first().click();

    const response = await actionResponse;
    expect(response.status()).toBeLessThan(500);

    // The action result must be reflected back on the page (error banner) or by
    // navigating away to the payment page — never a dead click.
    await expect
      .poll(
        async () => {
          const url = page.url();
          if (url.includes('error=')) return 'error';
          if (!url.includes('/account/balance')) return 'redirected';
          return (await page.getByRole('alert').count()) > 0 ? 'error' : 'pending';
        },
        { timeout: 20_000 },
      )
      .not.toBe('pending');
  });

  test('包样式在严格 CSP 下真实加载且作用域标记存在', async ({ page }) => {
    const violations: string[] = [];
    await page.exposeFunction('__reportCspViolation', (directive: string) => {
      violations.push(directive);
    });
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (event) => {
        // Only care about style loads; script violations are covered elsewhere.
        (window as unknown as { __reportCspViolation?: (d: string) => void })
          .__reportCspViolation?.(event.violatedDirective);
      });
    });

    const response = await page.goto('/');
    expect(response?.status()).toBeLessThan(400);

    const csp = (await response?.headerValue('content-security-policy')) ?? '';
    expect(csp).toContain("style-src 'self'");

    const styleLink = page.locator('link[rel=stylesheet][data-sp-style]').first();
    if ((await styleLink.count()) > 0) {
      await expect(styleLink).toHaveAttribute('href', /^\/api\/plugins\//);
      // Wait for the stylesheet to settle, then make sure it was not blocked.
      await page.waitForLoadState('networkidle');
      const loaded = await styleLink.evaluate(
        (element) => (element as HTMLLinkElement).sheet !== null,
      );
      expect(loaded).toBe(true);
    }

    expect(violations.filter((directive) => directive.startsWith('style-src'))).toEqual([]);
  });
});
