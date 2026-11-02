import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * 两条「插件数据写坏了但没人报错」的内核缺陷。
 *
 *  1. `ctx.extensions` 的 owner 恒为 null → `scoped` 模型的 `owner_id` 落 NULL
 *     → 用户看到「添加成功」+「列表空」，数据静默变孤儿。
 *  2. `deactivate` 先跑 `onDeactivate`（插件在那里 `resetContext()`），之后才把
 *     state 置为 registered → 中间窗口内路由仍判定 active，请求拿到
 *     `zjmf.not_ready` 而不是干净的 404。
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relative: string): string => readFileSync(path.join(root, relative), 'utf8');

describe('ctx.extensions carries the acting user', () => {
  it('resolves the owner from the request context, not from activation time', () => {
    const runtime = read('src/plugins/runtime.ts');
    // getter 而不是快照值：ctx 在激活期内是同一个对象，而 actor 每请求变化。
    expect(runtime).toMatch(/get extensions\(\)/);
    expect(runtime).toContain('actorContext.getStore()');
    // 曾经的写法：激活时就把 owner 固定成 null。
    expect(runtime).not.toContain('extensions: this.options.extensions.client(pluginId, null)');
  });

  it('establishes the actor around plugin route dispatch', () => {
    const dispatcher = read('src/plugins/dispatcher.ts');
    expect(dispatcher).toContain('runAsActor(request.user?.id ?? null');
  });

  it('forwards the actor across the isolate IPC boundary', () => {
    // AsyncLocalStorage 跨不过 IPC：worker 必须随帧带上 actorId，host 重建。
    const worker = read('src/plugins/isolated/worker.ts');
    expect(worker).toContain('actorId: actorId.getStore()');
    expect(worker).toContain('runAsActor(requestUser?.id');
    const host = read('src/plugins/isolated/host.ts');
    expect(host).toContain('actorId?: string');
    expect(host).toContain('runAsActor(frameActor');
  });

  it('behaves as documented: no actor means system context', async () => {
    // 用真实的 AsyncLocalStorage 语义验证「不传 actor 就不建立上下文」，
    // 避免把匿名访客误当成某个 owner。
    const storage = new AsyncLocalStorage<string>();
    const read_ = () => storage.getStore() ?? null;
    expect(read_()).toBeNull();
    expect(await storage.run('u1', async () => read_())).toBe('u1');
    expect(read_()).toBeNull();
    // 并发隔离：两个身份互不串台。
    const [a, b] = await Promise.all([
      storage.run('a', async () => {
        await new Promise((r) => setTimeout(r, 5));
        return read_();
      }),
      storage.run('b', async () => read_()),
    ]);
    expect(a).toBe('a');
    expect(b).toBe('b');
  });
});

describe('deactivate closes the gate before tearing down', () => {
  it('flips state to registered before onDeactivate and drains first', () => {
    const runtime = read('src/plugins/runtime.ts');
    const start = runtime.indexOf('private async deactivateUnlocked');
    const body = runtime.slice(start, start + 2000);

    const stateIdx = body.indexOf("plugin.state = 'registered'");
    const drainIdx = body.indexOf('await this.waitForDrain(plugin)');
    const hookIdx = body.indexOf('plugin.definition.onDeactivate');

    expect(stateIdx).toBeGreaterThan(-1);
    expect(drainIdx).toBeGreaterThan(-1);
    expect(hookIdx).toBeGreaterThan(-1);
    // 顺序就是修复本身：关闸 → 等排空 → 拆装备。
    expect(stateIdx).toBeLessThan(drainIdx);
    expect(drainIdx).toBeLessThan(hookIdx);
  });
});
