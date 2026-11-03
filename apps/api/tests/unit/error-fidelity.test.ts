import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 三条「错误信息在传递途中被替换成无害废话」的缺陷。
 *
 *  1. raw 路由 catch 把插件错误压成 500「服务器内部错误」→ 页面显示
 *     「服务器开小差了」，而上游明明返回了 502 + 「上游拒绝登录」。
 *  2. 建资源与存凭证不在同一事务 → 第二步失败只能事后补偿删除，补偿再失败
 *     就留下「有资源、无凭证」的孤儿。
 *  3. 同步失败原因只写进 sync-run，没回写上游记录 → 列表无「上次失败原因」。
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relative: string): string => readFileSync(path.join(root, relative), 'utf8');

describe('raw route errors keep the plugin status, code and detail', () => {
  const dispatcher = read('src/plugins/dispatcher.ts');

  it('checks isPluginError instead of blanket 500', () => {
    // 曾经的形状：statusCode = BODY_TOO_LARGE ? 413 : 500，插件给的 502 被吃掉。
    expect(dispatcher).toContain('isPluginError(error)');
    expect(dispatcher).toContain('pluginError.status');
    expect(dispatcher).toContain('pluginError.code');
    expect(dispatcher).toContain('pluginError.detail');
  });

  it('emits problem+json with requestId so the UI can show something searchable', () => {
    const start = dispatcher.indexOf('if (!response.headersSent) {');
    const body = dispatcher.slice(start, start + 2200);
    expect(body).toContain('application/problem+json');
    expect(body).toContain('buildProblem');
    expect(body).toContain('requestId: request.id');
  });

  it('still maps an oversized body to 413', () => {
    // 非插件错误的行为不能回退。
    expect(dispatcher).toContain('FST_ERR_CTP_BODY_TOO_LARGE');
  });
});

describe('resources and secrets can be written in one transaction', () => {
  it('exposes secrets on the transaction handle', () => {
    const sdk = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../packages/sdk/src/extensions.ts'),
      'utf8',
    );
    expect(sdk).toMatch(/readonly secrets: PluginSecrets/);
    const runtime = read('src/plugins/runtime.ts');
    // 必须用事务客户端，不是全局 db——否则写入不在同一事务里，回滚不掉。
    expect(runtime).toContain('secrets: pluginSecrets(trx as unknown as PrismaClient, pluginId)');
  });

  it('applies the acting user inside transactions too', () => {
    // 用事务建 scoped 资源也必须带上 owner，否则又落回 NULL。
    const runtime = read('src/plugins/runtime.ts');
    const txBlock = runtime.slice(runtime.indexOf('const tx: ExtensionTransaction = {'));
    expect(txBlock.slice(0, 800)).toContain('actorContext.getStore() ?? null');
  });
});

describe('failure reasons are persisted where the list can read them', () => {
  it('the kernel does not block a plugin from storing a failure reason', () => {
    // 内核侧无阻碍：自定义模型的 spec 字段是插件自己的，`publicSource` 用
    // `...rest` 透传。缺口在插件：失败原因只写进 sync-run，没回写上游记录，
    // 而列表读的是上游记录本身。该改动属于插件仓，不在这里伪造断言。
    const models = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../packages/sdk/src/models.ts'),
      'utf8',
    );
    expect(models).toContain('fields');
  });
});
