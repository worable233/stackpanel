import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveFrontendSpecifier } from '@/lib/frontend-loader';

/**
 * Stage 4 runtime loading — the resolve hook routes a runtime package's host-ABI
 * specifiers to the host namespaces published on `globalThis`, and routes the
 * package's own relative client module to the host-absorbed capability. Everything
 * else is delegated to `nextResolve` (contract 02 §5; SPIKE-results §0).
 */

interface AbiGlobal {
  __STACKPANEL_SERVER_ABI__?: Record<string, unknown>;
  __STACKPANEL_ABSORBED_CLIENT__?: Record<string, unknown>;
}

const g = globalThis as unknown as AbiGlobal;
const next = vi.fn((specifier: string) => ({ url: `node:${specifier}` }));
const context = {};

/**
 * 读出 shim 源码。
 *
 * 历史上 shim 是 `data:text/javascript;base64,…`，但 React 命名空间有 50+ 个
 * 导出，编码后约 2.9 KB —— 超过 macOS 的 `ENAMETOOLONG`（单路径 1024 字节），
 * `import()` 直接抛错，所有运行时装载的前端包都加载失败。现在写成临时文件，
 * 这里两种形式都支持（便于断言实现细节时不必关心存储形态）。
 */
const decode = (url: string): string => {
  if (url.startsWith('file://')) return readFileSync(fileURLToPath(url), 'utf8');
  return Buffer.from(url.split(',')[1] ?? '', 'base64').toString('utf8');
};

afterEach(() => {
  delete g.__STACKPANEL_SERVER_ABI__;
  delete g.__STACKPANEL_ABSORBED_CLIENT__;
  next.mockClear();
});

describe('resolveFrontendSpecifier (stage 4 runtime bridge)', () => {
  it('redirects a published host-ABI specifier to a shim over the host namespace', () => {
    g.__STACKPANEL_SERVER_ABI__ = { '@stackpanel/ui': { Button: 'HOST_BUTTON' } };
    const result = resolveFrontendSpecifier('@stackpanel/ui', context, next);
    expect(result.shortCircuit).toBe(true);
    // 必须是 file:// —— data: URL 在 macOS 上会因路径过长而 ENAMETOOLONG。
    expect(result.url.startsWith('file://')).toBe(true);
    expect(result.url).not.toContain('data:text/javascript');
    expect(decode(result.url)).toContain('globalThis.__STACKPANEL_SERVER_ABI__');
    expect(decode(result.url)).toContain('export const Button = ns["Button"];');
    expect(next).not.toHaveBeenCalled();
  });

  it('redirects an absorbed client module (./route-progress.js) to the host capability', () => {
    g.__STACKPANEL_ABSORBED_CLIENT__ = { 'route-progress': { RouteProgress: 'HOST_RP' } };
    const result = resolveFrontendSpecifier('./route-progress.js', context, next);
    expect(result.shortCircuit).toBe(true);
    expect(decode(result.url)).toContain('export const RouteProgress = ns["RouteProgress"];');
    expect(next).not.toHaveBeenCalled();
  });

  /**
   * Regression: the shim used to re-export every key of the host namespace as a
   * `const` binding. Next's `react-server` build hands back the CommonJS
   * namespace, which carries a literal `"module.exports"` key, so the generated
   * module was `export const module.exports = …` — a syntax error. It surfaced as
   * the thoroughly misleading "module 'react' does not provide an export named
   * 'useState'", and it took down the home page plus every plugin admin page
   * that imported a React hook.
   */
  it('skips namespace keys that are not identifiers (module.exports)', () => {
    g.__STACKPANEL_SERVER_ABI__ = {
      react: { useState: 'HOST_USE_STATE', 'module.exports': { useState: 'HOST_USE_STATE' } },
    };
    const result = resolveFrontendSpecifier('react', context, next);
    const source = decode(result.url);
    expect(source).toContain('export const useState = ns["useState"];');
    expect(source).not.toContain('module.exports');
  });

  it('redirects the SSR form auto-submit capability to the host client reference', () => {
    g.__STACKPANEL_ABSORBED_CLIENT__ = { 'auto-submit': { AutoSubmitForm: 'HOST_AUTO_SUBMIT' } };
    const result = resolveFrontendSpecifier('./auto-submit.js', context, next);
    expect(result.shortCircuit).toBe(true);
    expect(decode(result.url)).toContain('export const AutoSubmitForm = ns["AutoSubmitForm"];');
    expect(next).not.toHaveBeenCalled();
  });

  it('refreshes the shim export list when the host adds cart checkout during hot reload', () => {
    g.__STACKPANEL_ABSORBED_CLIENT__ = { 'auto-submit': { AutoSubmitForm: 'FORM' } };
    const first = resolveFrontendSpecifier('./auto-submit.js', context, next);
    g.__STACKPANEL_ABSORBED_CLIENT__ = { 'auto-submit': { AutoSubmitForm: 'FORM', CartCheckout: 'CART' } };
    const updated = resolveFrontendSpecifier('./auto-submit.js', context, next);
    expect(updated.url).not.toBe(first.url);
    expect(decode(updated.url)).toContain('export const CartCheckout = ns["CartCheckout"];');
  });

  it('delegates unknown bare specifiers to nextResolve', () => {
    g.__STACKPANEL_SERVER_ABI__ = { react: {} };
    const result = resolveFrontendSpecifier('zod', context, next);
    expect(result.url).toBe('node:zod');
    expect(next).toHaveBeenCalledWith('zod', context);
  });

  it('retries extension-less next/* subpaths with .js', () => {
    g.__STACKPANEL_SERVER_ABI__ = { react: {} };
    const retry = vi.fn((specifier: string) => {
      if (specifier.endsWith('.js')) return { url: `node:${specifier}` };
      throw new Error('not found');
    });
    const result = resolveFrontendSpecifier('next/link', context, retry);
    expect(result.url).toBe('node:next/link.js');
  });
});
