import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * 装载失败的**可诊断性**与**负缓存**（线上 `/account/referral` 一直 404 的修复）。
 *
 * 事故形态：插件的服务端入口里有一个客户端模块（`route-progress.tsx` 的
 * `import { useState } from 'react'`），宿主 RSC 的 `react` 没有这个导出，Node ESM
 * 链接抛 `SyntaxError`，`loadRuntimeFrontend` 返回 `null`，调用方把它当成「包里没有
 * 这个页面」→ 界面显示「未找到这个账户页面」。运维看到 404，日志里却是加载失败。
 *
 * 两个必须锁住的行为：
 * 1. 失败原因要能被调用方读到（`runtimeFrontendFailure`），否则无法把「崩了」和
 *    「没有」区分开；
 * 2. 失败结果要按入口**冷却**一段时间，否则每次渲染都会重新走一遍模块链接——
 *    这既是延迟，也是线上把内存推高的推手。
 */

const DATA_ENV = 'STACKPANEL_DATA_DIR';
let dir: string;

/** 每个用例重新导入模块，避免 globalThis 上的缓存跨用例串味。 */
async function freshRuntime() {
  vi.resetModules();
  return import('@/lib/frontend-runtime');
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'sp-fe-fail-'));
  process.env[DATA_ENV] = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env[DATA_ENV];
  vi.restoreAllMocks();
});

function writeBrokenPackage(id: string, source: string): string {
  const dist = path.join(dir, 'plugins', id, 'frontend', 'dist');
  mkdirSync(dist, { recursive: true });
  const entry = path.join(dist, 'index.js');
  writeFileSync(entry, source);
  return entry;
}

describe('runtimeFrontendFailure (装载失败原因)', () => {
  it('returns null for a package that was never loaded', async () => {
    const { runtimeFrontendFailure } = await freshRuntime();
    writeBrokenPackage('clean', 'export default { ui: {} }');
    expect(runtimeFrontendFailure('plugins', 'clean')).toBeNull();
  });

  it('records why a package failed to link, so callers can tell it from 404', async () => {
    const { loadRuntimeFrontend, runtimeFrontendFailure } = await freshRuntime();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // 链接期错误：`export { missing }` 引用一个不存在的本地绑定。
    writeBrokenPackage('bad', 'export { notDefined } from "./nope.js";\n');

    expect(await loadRuntimeFrontend('plugins', 'bad')).toBeNull();
    const reason = runtimeFrontendFailure('plugins', 'bad');
    expect(reason).toBeTruthy();
    expect(reason).not.toBe('');
  });

  it('does not retry within the cooldown, so a broken package cannot be re-linked on every render', async () => {
    const { loadRuntimeFrontend, FRONTEND_LOAD_FAILURE_COOLDOWN_MS } = await freshRuntime();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    writeBrokenPackage('bad', 'export { notDefined } from "./nope.js";\n');

    await loadRuntimeFrontend('plugins', 'bad');
    const firstPass = errors.mock.calls.length;
    expect(firstPass).toBeGreaterThan(0);

    // 冷却期内再加载：直接返回 null，不再进入 import()。
    await loadRuntimeFrontend('plugins', 'bad');
    const cooldownMessages = errors.mock.calls
      .slice(firstPass)
      .map((call) => String(call[0]))
      .join('\n');
    expect(cooldownMessages).toContain('冷却中');
    expect(FRONTEND_LOAD_FAILURE_COOLDOWN_MS).toBeGreaterThan(0);
  });

  it('forgets the failure once the cooldown has elapsed, so a fixed package recovers', async () => {
    const { loadRuntimeFrontend, runtimeFrontendFailure, FRONTEND_LOAD_FAILURE_COOLDOWN_MS } =
      await freshRuntime();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    writeBrokenPackage('bad', 'export { notDefined } from "./nope.js";\n');
    await loadRuntimeFrontend('plugins', 'bad');

    // 冷却期之后，失败记录不再生效（页面重新尝试装载，运维重装插件即可自愈）。
    expect(
      runtimeFrontendFailure('plugins', 'bad', undefined, Date.now() + FRONTEND_LOAD_FAILURE_COOLDOWN_MS + 1),
    ).toBeNull();
  });

  it('succeeds for a healthy package and records no failure', async () => {
    const { loadRuntimeFrontend, runtimeFrontendFailure } = await freshRuntime();
    writeBrokenPackage('good', 'export default { ui: { accountPages: { "account/good": () => null } } };\n');

    const loaded = (await loadRuntimeFrontend('plugins', 'good')) as {
      ui: { accountPages: Record<string, unknown> };
    };
    expect(Object.keys(loaded.ui.accountPages)).toEqual(['account/good']);
    expect(runtimeFrontendFailure('plugins', 'good')).toBeNull();
  });
});
