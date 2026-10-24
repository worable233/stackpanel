import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import {
  createRecoveryServer,
  type RecoveryDeps,
  type RecoveryServerHandle,
} from '../src/recovery-entry.ts';

const TOKEN = 'recovery-token-0123456789abcdef';

function deps(overrides: Partial<RecoveryDeps> = {}): RecoveryDeps {
  return {
    token: TOKEN,
    readStatus: async () => ({
      generation: 3,
      digest: 'sha256:abc',
      activeTask: null,
      recent: [],
    }),
    retry: async () => ({ ok: true, detail: 'retried' }),
    rollback: async () => ({ ok: true, detail: 'rolled back' }),
    reconcile: async () => ({ ok: true, detail: 'reconciled' }),
    ...overrides,
  };
}

async function start(options: Parameters<typeof createRecoveryServer>[0]): Promise<{
  handle: RecoveryServerHandle;
  base: string;
}> {
  // 不在这里 listen：监听必须由 createRecoveryServer 自己完成，否则生产里
  // 「日志说在监听、端口其实没绑」的缺陷会被测试掩盖（真机演练抓到）。
  const handle = await createRecoveryServer(options);
  const { port } = handle.server.address() as AddressInfo;
  return { handle, base: `http://127.0.0.1:${port}` };
}

let open: RecoveryServerHandle | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
});

describe('recovery entry', () => {
  it('refuses to start without an independent token', async () => {
    await expect(
      createRecoveryServer({ port: 0, deps: deps({ token: 'short' }) }),
    ).rejects.toThrow(/独立令牌/);
  });

  it('serves a fixed page and health without auth', async () => {
    const started = await start({ port: 0, deps: deps() });
    open = started.handle;
    const page = await fetch(`${started.base}/recovery`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('StackPanel 恢复入口');
    const health = await fetch(`${started.base}/health`);
    expect(health.status).toBe(200);
  });

  it('rejects unauthenticated recovery actions', async () => {
    const started = await start({ port: 0, deps: deps() });
    open = started.handle;
    const res = await fetch(`${started.base}/recovery/api/status`);
    expect(res.status).toBe(401);
  });

  it('returns status with the independent bearer token', async () => {
    const started = await start({ port: 0, deps: deps() });
    open = started.handle;
    const res = await fetch(`${started.base}/recovery/api/status`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: { generation: number } };
    expect(body.status.generation).toBe(3);
  });

  it('performs only whitelisted actions (retry/rollback/reconcile)', async () => {
    const calls: string[] = [];
    const started = await start({
      port: 0,
      deps: deps({
        retry: async (key) => {
          calls.push(`retry:${key ?? ''}`);
          return { ok: true, detail: 'retried' };
        },
        rollback: async () => {
          calls.push('rollback');
          return { ok: true, detail: 'rolled back' };
        },
        reconcile: async () => {
          calls.push('reconcile');
          return { ok: true, detail: 'reconciled' };
        },
      }),
    });
    open = started.handle;
    const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
    await fetch(`${started.base}/recovery/api/reconcile`, { method: 'POST', headers });
    await fetch(`${started.base}/recovery/api/rollback`, { method: 'POST', headers });
    await fetch(`${started.base}/recovery/api/retry`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ idempotencyKey: 'k1' }),
    });
    expect(calls).toEqual(['reconcile', 'rollback', 'retry:k1']);
  });

  it('does not expose arbitrary command execution', async () => {
    const started = await start({ port: 0, deps: deps() });
    open = started.handle;
    const res = await fetch(`${started.base}/recovery/api/exec`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(405);
  });
});

describe('recovery entry shutdown', () => {
  it('close() is idempotent and safe before/after listening', async () => {
    // 真机重启抓到：重复 close 抛 ERR_SERVER_NOT_RUNNING，进程以未捕获异常退出。
    const handle = await createRecoveryServer({ port: 0, deps: deps() });
    await handle.close();
    await expect(handle.close()).resolves.toBeUndefined();
  });
});
