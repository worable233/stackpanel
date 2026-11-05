import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * zjmf 五项遗留缺陷的守卫（审计点名、长期未修）。
 *
 * 源码在**独立插件仓**（`STACKPANEL_PLUGIN_SOURCES` 或同级 `StackPanel-plugins`）。
 * 找不到就整组跳过 —— 内核仓的测试不该依赖另一个仓库的检出状态。
 *
 * 每一条都写成「回退旧行为就变红」，避免这些缺陷再被当成已完成。
 */

const PLUGIN_SOURCES = process.env.STACKPANEL_PLUGIN_SOURCES;
// 用 `import.meta.url` 而不是 `process.cwd()`：后者随 vitest 的 root 变化。
// 本文件位置确定（apps/api/tests/unit → 仓库根是 ../../../..）。
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const CANDIDATES = [
  PLUGIN_SOURCES ? path.join(PLUGIN_SOURCES, 'packages/plugins') : null,
  path.join(REPO_ROOT, '../StackPanel-plugins/packages/plugins'),
].filter((value): value is string => Boolean(value));

const pluginRoot = CANDIDATES.find((dir) => existsSync(path.join(dir, 'zjmf-upstream/src')));
const upstreamSrc = pluginRoot ? path.join(pluginRoot, 'zjmf-upstream/src') : null;
const compatSrc = pluginRoot ? path.join(pluginRoot, 'zjmf-compat/src') : null;
const hasSources = Boolean(upstreamSrc && compatSrc);

function read(dir: string, file: string): string {
  return readFileSync(path.join(dir, file), 'utf8');
}

describe.skipIf(!hasSources)('zjmf 遗留缺陷守卫', () => {
  it('履约把归属用户写进服务实例 runtime（owner 传播）', () => {
    const source = read(upstreamSrc!, 'provider.ts');
    // `ctx.userId` 之前只用来算幂等指纹，从未写进任何可查询的地方 ——
    // 上游导入的实例无法反查「它属于谁」，对账和客服排查只能靠 orderId。
    expect(source).toContain('userId: ctx.userId');
    // 必须在返回给 store 的 runtime 对象里（与 upstreamId 同处）。
    const upstreamIdx = source.indexOf('        upstreamId,');
    const userIdx = source.indexOf('        userId: ctx.userId');
    expect(upstreamIdx).toBeGreaterThan(-1);
    expect(userIdx).toBeGreaterThan(upstreamIdx);
  });

  it('定时同步失败回写上游记录，不只进日志（防死信）', () => {
    const source = read(upstreamSrc!, 'index.ts');
    // `syncDue` 的 catch 曾经只有 logger.warn。`syncSourceOnce` 内部虽然会写
    // `lastSyncError`，但**拿不到同步锁**的那条路径在它之外抛出，只进日志 ——
    // 用户看列表只见 lastAttemptAtMs 有值、状态回到 IDLE，不知道为什么没成。
    const dueIdx = source.indexOf('private async syncDue(');
    expect(dueIdx).toBeGreaterThan(-1);
    const callIdx = source.indexOf('await this.recordScheduledFailure(source, error)');
    expect(callIdx).toBeGreaterThan(dueIdx);
    // 写稳定 code 而不是散文（ADR-0012：code 是契约，文案归界面）。
    expect(source).toContain('lastSyncError: code,');
  });

  it('compat 停用时清空模块级引用', () => {
    const source = read(compatSrc!, 'index.ts');
    const deactivate = source.slice(source.indexOf('onDeactivate'));
    // 旧实例被复用时，它内存的是已失效的 PluginContext（secrets 句柄等），
    // 下一次请求会拿着死句柄去读密钥。
    expect(deactivate).toContain('service = null;');
  });

  it('compat 创建连接把唯一索引冲突译成业务错误（凭证非原子）', () => {
    const source = read(compatSrc!, 'service.ts');
    // 应用层「先查后写」挡不住并发：两个请求可同时通过 `existing.items.length === 0`。
    // 真正的闸门是 `username` 唯一索引，但它抛数据库错误，用户看不懂。
    expect(source).toContain('isUniqueViolation(error)');
    expect(source).toContain("'zjmf-compat.username_taken'");
    // 必须与查重路径给出**同一个** code：用户无需知道自己走了哪条路径。
    const catchIdx = source.indexOf('isUniqueViolation(error)');
    const codeIdx = source.indexOf("'zjmf-compat.username_taken'", catchIdx);
    expect(codeIdx).toBeGreaterThan(catchIdx);
  });
});
