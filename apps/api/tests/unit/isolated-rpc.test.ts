import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { loadIsolatedPluginDefinition, stopIsolatedPlugin } from '../../src/plugins/isolated/host.ts';
import { isPluginError } from '@stackpanel/sdk';
import type { PluginManifest, RawHttpReply, RawHttpRequest, LlmProvider, PluginContext } from '@stackpanel/sdk';

type Message = {
  protocol: 1;
  pluginId: string;
  type: string;
  id?: string;
  capability?: string;
  method?: string;
  route?: string;
  request?: unknown;
  args?: unknown;
  token?: string;
  payload?: unknown;
  phase?: string;
  routes?: unknown[];
  models?: Array<Record<string, unknown>>;
  context?: unknown;
  value?: unknown;
  error?: { message: string };
};

const pluginId = 'isolated-rpc-test';
const worker = fileURLToPath(new URL('../../src/plugins/isolated/worker.ts', import.meta.url));
const entry = fileURLToPath(new URL('../fixtures/isolated-rpc-plugin.mjs', import.meta.url));
const children: ChildProcess[] = [];

function execArgv(): string[] {
  const result: string[] = [];
  for (let index = 0; index < process.execArgv.length; index += 1) {
    const arg = process.execArgv[index];
    if (arg === '--import' || arg === '--loader') {
      const value = process.execArgv[index + 1];
      if (value) result.push(arg, value);
      index += 1;
    } else if (arg?.startsWith('--import=') || arg?.startsWith('--loader=')) {
      result.push(arg);
    }
  }
  return result;
}

const messageQueues = new WeakMap<ChildProcess, { messages: Message[]; waiters: Array<(message: Message) => void> }>();

function nextMessage(child: ChildProcess): Promise<Message> {
  let queue = messageQueues.get(child);
  if (!queue) {
    queue = { messages: [], waiters: [] };
    messageQueues.set(child, queue);
    child.on('message', (message: Message) => {
      const waiter = queue?.waiters.shift();
      if (waiter) waiter(message);
      else queue?.messages.push(message);
    });
  }
  const queued = queue.messages.shift();
  if (queued) return Promise.resolve(queued);
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      child.off('error', onError);
      reject(error);
    };
    child.once('error', onError);
    queue?.waiters.push((message) => {
      child.off('error', onError);
      resolve(message);
    });
  });
}

function send(child: ChildProcess, message: Message): void {
  child.send(message);
}

function messageId(message: Message): string {
  if (!message.id) throw new Error(`message ${message.type} has no id`);
  return message.id;
}

/** Minimal host-side `RawHttpReply` capturing the plugin's output. */
function captureReply(): { reply: RawHttpReply; chunks: Buffer[]; status: number; headers: Array<[string, string | string[]]>; closed: () => void; closedFns: Array<() => void>; destroyed: () => boolean } {
  const chunks: Buffer[] = [];
  const headers: Array<[string, string | string[]]> = [];
  const closedFns: Array<() => void> = [];
  const holder = { statusCode: 200, headersSent: false, destroyed: false, destroy() { holder.destroyed = true; } };
  const reply = {
    status(code: number) { holder.statusCode = code; return reply; },
    header(name: string, value: string | string[]) { headers.push([name, value]); return reply; },
    write(chunk: string | Uint8Array) { chunks.push(Buffer.from(chunk)); return true; },
    end(body?: string | Uint8Array) { if (body !== undefined) chunks.push(Buffer.from(body)); },
    hijack() { /* already hijacked */ },
    onClientClose(fn: () => void) { closedFns.push(fn); },
    raw: holder,
  } as unknown as RawHttpReply;
  return {
    reply,
    chunks,
    get status() { return holder.statusCode; },
    headers,
    closedFns,
    closed: () => { for (const fn of closedFns.splice(0)) fn(); },
    destroyed: () => holder.destroyed,
  };
}

/**
 * A deliberately slow host-side reply: `write()` reports backpressure once it
 * holds more than {@link SLOW_REPLY_HIGH_WATER} bytes, and the registered
 * `drain` listener fires only when a background "consumer" has caught up. This
 * exercises the real path where the client reads slower than the upstream
 * produces, which is what the bounded raw queue must survive.
 */
const SLOW_REPLY_HIGH_WATER = 128 * 1024;

function captureSlowReply(): {
  reply: RawHttpReply;
  chunks: Buffer[];
  startDraining: () => Promise<void>;
  stopDraining: () => void;
  backpressureEvents: () => number;
  maxBufferedBytes: () => number;
} {
  const chunks: Buffer[] = [];
  let buffered = 0;
  let maxBuffered = 0;
  let backpressure = 0;
  let draining = false;
  const drainListeners: Array<() => void> = [];
  const holder = {
    statusCode: 200,
    headersSent: false,
    destroyed: false,
    destroy() { holder.destroyed = true; },
    once(event: string, fn: () => void) { if (event === 'drain') drainListeners.push(fn); },
    off() { /* tests never remove listeners */ },
  };
  const reply = {
    status(code: number) { holder.statusCode = code; return reply; },
    header() { return reply; },
    write(chunk: string | Uint8Array) {
      const data = Buffer.from(chunk);
      chunks.push(data);
      buffered += data.length;
      if (buffered > maxBuffered) maxBuffered = buffered;
      if (buffered >= SLOW_REPLY_HIGH_WATER) {
        backpressure += 1;
        return false;
      }
      return true;
    },
    end(body?: string | Uint8Array) { if (body !== undefined) reply.write(body); },
    hijack() { /* already hijacked */ },
    onClientClose() { /* not exercised */ },
    raw: holder,
  } as unknown as RawHttpReply;
  const startDraining = async (): Promise<void> => {
    // Consume a little at a time, waking anyone parked on `drain` each round.
    draining = true;
    while (draining) {
      await new Promise((resolve) => setImmediate(resolve));
      if (buffered > 0) {
        buffered = Math.max(0, buffered - 256 * 1024);
        const listeners = drainListeners.splice(0, drainListeners.length);
        for (const fn of listeners) fn();
      }
    }
  };
  const stopDraining = (): void => {
    draining = false;
  };
  return {
    reply,
    chunks,
    startDraining,
    stopDraining,
    backpressureEvents: () => backpressure,
    maxBufferedBytes: () => maxBuffered,
  };
}

function rawRequest(body: Buffer, headers: Record<string, string | string[] | undefined> = {}, query = '', method = 'POST'): RawHttpRequest {
  return {
    method,
    url: `/raw/echo${query}`,
    params: { '*': 'echo' },
    query: new URLSearchParams(query.replace(/^\?/, '')),
    headers,
    body: Readable.from(body.length === 0 ? [] : [body]),
    raw: {},
  };
}

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGTERM');
});

describe('isolated worker RPC protocol', () => {
  it('reconstructs custom model schemas in the host process', async () => {
    const id = 'isolated-model-test';
    const manifest: PluginManifest = { id, name: 'Model test', version: '1.0.0' };
    const definition = await loadIsolatedPluginDefinition(id, entry, manifest);
    try {
      expect(definition.customModels).toHaveLength(1);
      const model = definition.customModels?.[0];
      expect(model?.kind).toBe('rpc/note');
      expect(model?.schema.safeParse({ title: 'ok' }).success).toBe(true);
      expect(model?.schema.safeParse({ title: 1 }).success).toBe(false);
    } finally {
      stopIsolatedPlugin(id);
    }
  });

  it('keeps a plugin error branded and preserves its status across IPC', async () => {
    // Regression: the worker used to rebuild host/plugin errors as plain `Error`
    // objects with copied fields, which lost the non-enumerable plugin-error
    // brand. The kernel boundary then treated a deliberate 409 as a generic 500,
    // and plugin code branching on `instanceof PluginError` rewrote the cause.
    const id = 'isolated-error-status-test';
    const manifest: PluginManifest = { id, name: 'Error status test', version: '1.0.0' };
    const definition = await loadIsolatedPluginDefinition(id, entry, manifest);
    try {
      const route = definition.routes?.find((candidate) => candidate.path === '/error-status');
      expect(route).toBeDefined();
      let failure: unknown = null;
      try {
        await route?.handler(
          { params: {}, query: {}, body: null, headers: {} } as never,
          { code: () => undefined, send: () => undefined } as never,
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      const pluginError = failure as { code?: string; status?: number; detail?: string };
      expect(pluginError.code).toBe('probe.invalid');
      expect(pluginError.status).toBe(409);
      expect(pluginError.detail).toBe('冲突：状态不允许');
      expect(isPluginError(failure)).toBe(true);
    } finally {
      stopIsolatedPlugin(id);
    }
  }, 15_000);

  it('rejects an in-flight route when the isolated worker exits', async () => {
    const id = 'isolated-crash-test';
    const manifest: PluginManifest = { id, name: 'Crash test', version: '1.0.0' };
    const definition = await loadIsolatedPluginDefinition(id, entry, manifest);
    try {
      const crash = definition.routes?.find((route) => route.path === '/crash');
      expect(crash).toBeDefined();
      await expect(crash?.handler(
        { params: {}, query: {}, body: null, headers: {} } as never,
        { code: () => undefined, send: () => undefined } as never,
      )).rejects.toThrow(/exited|unavailable|timed out/);
    } finally {
      stopIsolatedPlugin(id);
    }
  }, 15_000);

  it('registers events/jobs and handles host callbacks over IPC', async () => {
    const child = fork(worker, [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      execArgv: execArgv(),
      env: {
        ...process.env,
        STACKPANEL_PLUGIN_ID: pluginId,
        STACKPANEL_PLUGIN_ENTRY: entry,
        STACKPANEL_PLUGIN_MANIFEST: JSON.stringify({ id: pluginId, name: 'RPC test', version: '1.0.0' }),
      },
    });
    children.push(child);

    const ready = await nextMessage(child);
    expect(ready).toMatchObject({ protocol: 1, pluginId, type: 'ready' });
    expect(ready.models).toHaveLength(1);
    expect(ready.models?.[0]).toMatchObject({ kind: 'rpc/note', indexes: [{ fields: ['title'] }] });

    send(child, {
      protocol: 1,
      pluginId,
      type: 'lifecycle',
      id: randomUUID(),
      phase: 'activate',
      context: {
        services: [
          { name: 'auth', methods: [], syncValues: { sessionCookieConfig: { name: 'session', ttlSeconds: 60, secure: true } } },
          { name: 'secrets', methods: [], syncValues: { isAvailable: true } },
          { name: 'payments', methods: [], syncValues: { listPaymentMethods: { wallet: { id: 'wallet', label: 'Wallet' }, providers: [] } } },
        ],
        extensions: [{ pointId: 'probe.point', ownerId: 'owner-plugin', index: 0, methods: ['run'], values: { id: 'snapshot-extension' } }],
      },
    });
    const lifecycleRequest = await nextMessage(child);
    expect(lifecycleRequest.type).toBe('capability');
    expect(lifecycleRequest.capability).toBe('events.subscribe');
    const declarativeToken = (lifecycleRequest.args as { token: string }).token;
    send(child, { protocol: 1, pluginId, type: 'result', id: messageId(lifecycleRequest), value: declarativeToken });
    const failingListenerRequest = await nextMessage(child);
    expect(failingListenerRequest.capability).toBe('events.subscribe');
    const failingToken = (failingListenerRequest.args as { token: string }).token;
    send(child, { protocol: 1, pluginId, type: 'result', id: messageId(failingListenerRequest), value: failingToken });
    const explicitEventRequest = await nextMessage(child);
    expect(explicitEventRequest.capability).toBe('events.subscribe');
    const eventToken = (explicitEventRequest.args as { token: string }).token;
    send(child, { protocol: 1, pluginId, type: 'result', id: messageId(explicitEventRequest), value: eventToken });
    const jobRequest = await nextMessage(child);
    expect(jobRequest.capability).toBe('jobs.handle');
    const jobToken = (jobRequest.args as { token: string }).token;
    send(child, { protocol: 1, pluginId, type: 'result', id: messageId(jobRequest), value: jobToken });
    const provideRequest = await nextMessage(child);
    expect(provideRequest.capability).toBe('services.provide');
    expect(provideRequest.args).toMatchObject({ name: 'probe.service', methods: ['greet'], values: { version: '1' } });
    send(child, { protocol: 1, pluginId, type: 'result', id: messageId(provideRequest), value: undefined });
    const extensionRequest = await nextMessage(child);
    expect(extensionRequest.capability).toBe('extensions.register');
    expect(extensionRequest.args).toMatchObject({ pointId: 'probe.extension', methods: ['run'], values: { id: 'rpc-extension' } });
    send(child, { protocol: 1, pluginId, type: 'result', id: messageId(extensionRequest), value: undefined });
    const lifecycleResult = await nextMessage(child);
    expect(lifecycleResult.type).toBe('result');

    // 宿主回调 worker 内的扩展实现时必须保留 receiver。类实例风格的实现依赖
    // this（如 provider 的 private 辅助方法），丢掉 this 会变成
    // "Cannot read properties of undefined"，而对象字面量实现看不出任何异常。
    const extensionToken = (extensionRequest.args as { token: string }).token;
    send(child, {
      protocol: 1,
      pluginId,
      type: 'service',
      id: randomUUID(),
      token: extensionToken,
      method: 'run',
      payload: ['probe'],
    });
    const extensionCall = await nextMessage(child);
    expect(extensionCall.type).toBe('result');
    expect(extensionCall.error).toBeUndefined();
    expect(extensionCall.value).toBe('probe:1');

    send(child, { protocol: 1, pluginId, type: 'event', token: eventToken, payload: { value: 'ok' } });
    const loggerRequest = await nextMessage(child);
    expect(loggerRequest).toMatchObject({ type: 'capability', capability: 'logger.info' });
    send(child, { protocol: 1, pluginId, type: 'result', id: messageId(loggerRequest), value: undefined });

    send(child, { protocol: 1, pluginId, type: 'event', token: failingToken, payload: { value: 'ignored' } });
    const failingLogger = await nextMessage(child);
    expect(failingLogger).toMatchObject({ type: 'capability', capability: 'logger.error' });
    send(child, { protocol: 1, pluginId, type: 'result', id: messageId(failingLogger), value: undefined });

    send(child, { protocol: 1, pluginId, type: 'job', id: randomUUID(), token: jobToken, payload: { id: 42 } });
    const enqueueRequest = await nextMessage(child);
    expect(enqueueRequest).toMatchObject({ type: 'capability', capability: 'jobs.enqueue' });
    expect(enqueueRequest.args).toMatchObject({ name: 'probe.followup', payload: { id: 42 } });
    send(child, { protocol: 1, pluginId, type: 'result', id: messageId(enqueueRequest), value: 'job-id' });
    const jobResult = await nextMessage(child);
    expect(jobResult.type).toBe('result');
    expect(jobResult.error).toBeUndefined();

    const invokeId = randomUUID();
    send(child, {
      protocol: 1,
      pluginId,
      type: 'invoke',
      id: invokeId,
      method: 'GET',
      route: '/services',
      request: { params: {}, query: {}, body: null, headers: {} },
    });
    const walletRequest = await nextMessage(child);
    expect(walletRequest.capability).toBe('wallet.getAccount');
    send(child, { protocol: 1, pluginId, type: 'result', id: messageId(walletRequest), value: null });
    const fxRequest = await nextMessage(child);
    expect(fxRequest.capability).toBe('fx.getRate');
    send(child, { protocol: 1, pluginId, type: 'result', id: messageId(fxRequest), value: null });
    const serviceResult = await nextMessage(child);
    expect(serviceResult).toMatchObject({
      type: 'result',
      id: invokeId,
      value: {
        account: null,
        rate: null,
        methods: { wallet: { id: 'wallet', label: 'Wallet' }, providers: [] },
      },
    });

    const syncInvokeId = randomUUID();
    send(child, {
      protocol: 1,
      pluginId,
      type: 'invoke',
      id: syncInvokeId,
      method: 'GET',
      route: '/sync-services',
      request: { params: {}, query: {}, body: null, headers: {} },
    });
    const syncResult = await nextMessage(child);
    expect(syncResult).toMatchObject({
      type: 'result',
      id: syncInvokeId,
      value: {
        cookie: { name: 'session', ttlSeconds: 60, secure: true },
        secrets: true,
        methods: { wallet: { id: 'wallet', label: 'Wallet' }, providers: [] },
      },
    });

    const lockInvokeId = randomUUID();
    send(child, {
      protocol: 1,
      pluginId,
      type: 'invoke',
      id: lockInvokeId,
      method: 'GET',
      route: '/state-lock',
      request: { params: {}, query: {}, body: null, headers: {} },
    });
    const lockRequest = await nextMessage(child);
    expect(lockRequest).toMatchObject({ type: 'capability', capability: 'state.withLock', args: { key: 'rpc-lock', ttlMs: 1000 } });
    const lockToken = (lockRequest.args as { token: string }).token;
    const callbackId = randomUUID();
    send(child, { protocol: 1, pluginId, type: 'state-lock', id: callbackId, token: lockToken });
    const callbackResult = await nextMessage(child);
    expect(callbackResult).toMatchObject({ type: 'result', id: callbackId });
    send(child, { protocol: 1, pluginId, type: 'result', id: messageId(lockRequest), value: true });
    const lockResult = await nextMessage(child);
    expect(lockResult).toMatchObject({ type: 'result', id: lockInvokeId, value: true });

    // 跨进程缓存：worker 把「查/回填/失效」拆成三步 IPC，存储与失效都留在内核侧。
    const cacheInvokeId = randomUUID();
    send(child, {
      protocol: 1,
      pluginId,
      type: 'invoke',
      id: cacheInvokeId,
      method: 'GET',
      route: '/cache',
      request: { params: {}, query: {}, body: null, headers: {} },
    });
    // 第一次 read：peek 未命中 → 回源 → put。
    const peek1 = await nextMessage(child);
    expect(peek1).toMatchObject({ type: 'capability', capability: 'cache.peek', args: { key: 'rpc-cache-probe' } });
    send(child, { protocol: 1, pluginId, type: 'result', id: messageId(peek1), value: { hit: false } });
    const put1 = await nextMessage(child);
    expect(put1).toMatchObject({
      capability: 'cache.put',
      args: { key: 'rpc-cache-probe', ttlMs: 30_000, kinds: ['rpc/note'] },
    });
    send(child, { protocol: 1, pluginId, type: 'result', id: messageId(put1), value: undefined });
    // 第二次 read：peek 命中 → 不回源。
    const peek2 = await nextMessage(child);
    expect(peek2.capability).toBe('cache.peek');
    send(child, { protocol: 1, pluginId, type: 'result', id: messageId(peek2), value: { hit: true, value: { value: 1 } } });
    // invalidate → peek 再次未命中 → 再回源。
    const invalidate = await nextMessage(child);
    expect(invalidate).toMatchObject({ capability: 'cache.invalidate', args: { kinds: ['rpc/note'] } });
    send(child, { protocol: 1, pluginId, type: 'result', id: messageId(invalidate), value: undefined });
    const peek3 = await nextMessage(child);
    send(child, { protocol: 1, pluginId, type: 'result', id: messageId(peek3), value: { hit: false } });
    const put2 = await nextMessage(child);
    expect(put2).toMatchObject({
      capability: 'cache.put',
      args: { key: 'rpc-cache-probe', value: { value: 2 }, kinds: ['rpc/note'] },
    });
    send(child, { protocol: 1, pluginId, type: 'result', id: messageId(put2), value: undefined });
    const cacheResult = await nextMessage(child);
    expect(cacheResult).toMatchObject({
      type: 'result',
      id: cacheInvokeId,
      value: { first: { value: 1 }, second: { value: 1 }, third: { value: 2 }, loads: 2 },
    });

    const modelInvokeId = randomUUID();
    send(child, {
      protocol: 1,
      pluginId,
      type: 'invoke',
      id: modelInvokeId,
      method: 'GET',
      route: '/models',
      request: { params: {}, query: {}, body: null, headers: {} },
    });
    const createRequest = await nextMessage(child);
    expect(createRequest.capability).toBe('extensions.create');
    expect(createRequest.args).toMatchObject({ kind: 'rpc/note', spec: { title: 'hello' }, options: { name: 'note-1' } });
    send(child, {
      protocol: 1,
      pluginId,
      type: 'result',
      id: messageId(createRequest),
      value: { name: 'note-1', spec: { title: 'hello' }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    });
    const getRequest = await nextMessage(child);
    expect(getRequest.capability).toBe('extensions.get');
    send(child, {
      protocol: 1,
      pluginId,
      type: 'result',
      id: messageId(getRequest),
      value: { name: 'note-1', spec: { title: 'hello' }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    });
    const modelResult = await nextMessage(child);
    expect(modelResult).toMatchObject({ type: 'result', id: modelInvokeId, value: { name: 'note-1', spec: { title: 'hello' } } });

    const snapshotInvokeId = randomUUID();
    send(child, {
      protocol: 1,
      pluginId,
      type: 'invoke',
      id: snapshotInvokeId,
      method: 'GET',
      route: '/snapshot',
      request: { params: {}, query: {}, body: null, headers: {} },
    });
    const extensionInvoke = await nextMessage(child);
    expect(extensionInvoke).toMatchObject({ type: 'capability', capability: 'extensions.invoke' });
    expect(extensionInvoke.args).toMatchObject({ pointId: 'probe.point', ownerId: 'owner-plugin', index: 0, method: 'run', args: ['x'] });
    send(child, { protocol: 1, pluginId, type: 'result', id: messageId(extensionInvoke), value: 'done' });
    const snapshotResult = await nextMessage(child);
    expect(snapshotResult).toMatchObject({ type: 'result', id: snapshotInvokeId, value: { id: 'snapshot-extension', result: 'done' } });

    // ctx.storage：worker 只拿到远程序 provider 代理；`backend()` 与每次方法调用
    // 都拆成 `storage.backend` / `storage.invoke` 两条 IPC，字节机制留在内核。
    const storageInvokeId = randomUUID();
    send(child, {
      protocol: 1,
      pluginId,
      type: 'invoke',
      id: storageInvokeId,
      method: 'GET',
      route: '/storage',
      request: { params: {}, query: {}, body: null, headers: {} },
    });
    const backendRequest = await nextMessage(child);
    expect(backendRequest).toMatchObject({
      type: 'capability',
      capability: 'storage.backend',
      args: { driver: 'local', root: '/tmp/isolated-storage' },
    });
    // Host builds the real provider and hands back only a serializable handle:
    // non-function values inline, method names for the worker to re-issue.
    send(child, {
      protocol: 1,
      pluginId,
      type: 'result',
      id: messageId(backendRequest),
      value: {
        token: 'storage:1',
        methods: ['beginPut', 'prepareGet', 'delete', 'exists', 'stat', 'list', 'url', 'ping'],
        values: { id: 'storage.local', name: '服务器本地盘', byteMode: 'spool' },
      },
    });
    // provider.beginPut(...) is proxied as storage.invoke.
    const beginPutRequest = await nextMessage(child);
    expect(beginPutRequest).toMatchObject({
      type: 'capability',
      capability: 'storage.invoke',
      args: {
        token: 'storage:1',
        method: 'beginPut',
        args: [{ key: 'media/2026/01/a/original.png', size: 3, contentType: 'image/png' }],
      },
    });
    send(child, {
      protocol: 1,
      pluginId,
      type: 'result',
      id: messageId(beginPutRequest),
      value: { spoolPath: '/tmp/isolated-storage/media/2026/01/a/original.png' },
    });
    // provider.stat(...) is another storage.invoke.
    const statRequest = await nextMessage(child);
    expect(statRequest).toMatchObject({ capability: 'storage.invoke', args: { token: 'storage:1', method: 'stat' } });
    send(child, {
      protocol: 1,
      pluginId,
      type: 'result',
      id: messageId(statRequest),
      value: { key: 'media/2026/01/a/original.png', size: 3 },
    });
    const storageResult = await nextMessage(child);
    expect(storageResult).toMatchObject({
      type: 'result',
      id: storageInvokeId,
      value: {
        id: 'storage.local',
        byteMode: 'spool',
        target: { spoolPath: '/tmp/isolated-storage/media/2026/01/a/original.png' },
        stat: { key: 'media/2026/01/a/original.png', size: 3 },
      },
    });
  });

  it('T8/T9 publish failures are not silent; intercept/waterfall report unsupported', async () => {
    const id = 'isolated-events-test';
    const child = fork(worker, [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      execArgv: execArgv(),
      env: {
        ...process.env,
        STACKPANEL_PLUGIN_ID: id,
        STACKPANEL_PLUGIN_ENTRY: entry,
        STACKPANEL_PLUGIN_MANIFEST: JSON.stringify({ id, name: 'Events test', version: '1.0.0' }),
      },
    });
    children.push(child);

    const ready = await nextMessage(child);
    expect(ready).toMatchObject({ protocol: 1, pluginId: id, type: 'ready' });

    // Activate: echo the subscribe token, ack every other registration.
    const lifecycleId = randomUUID();
    send(child, {
      protocol: 1,
      pluginId: id,
      type: 'lifecycle',
      id: lifecycleId,
      phase: 'activate',
      context: {},
    });
    for (;;) {
      const message = await nextMessage(child);
      if (message.type === 'result' && message.id === lifecycleId) break;
      if (message.type === 'capability') {
        const token = (message.args as { token?: string } | undefined)?.token;
        send(child, {
          protocol: 1,
          pluginId: id,
          type: 'result',
          id: messageId(message),
          value: message.capability === 'events.subscribe' ? token : undefined,
        });
      }
    }

    // T8: a failing `events.publish` RPC must produce a `logger.error`, not be
    // silently swallowed.
    const publishId = randomUUID();
    send(child, {
      protocol: 1,
      pluginId: id,
      type: 'invoke',
      id: publishId,
      method: 'GET',
      route: '/events-publish',
      request: { params: {}, query: {}, body: null, headers: {} },
    });
    const publishRequest = await nextMessage(child);
    expect(publishRequest).toMatchObject({ type: 'capability', capability: 'events.publish' });
    // Reject the RPC out-of-band; the worker should report via logger.error. The
    // handler does not await `publish`, so the invoke result and the async error
    // report can interleave — drain until the error surfaces.
    send(child, {
      protocol: 1,
      pluginId: id,
      type: 'result',
      id: messageId(publishRequest),
      error: { message: 'kernel link down' },
    });
    let publishResult: Message | undefined;
    let publishError: Message | undefined;
    for (let seen = 0; seen < 6 && !(publishResult && publishError); seen += 1) {
      const message = await nextMessage(child);
      if (message.type === 'capability' && message.capability === 'logger.error') {
        publishError = message;
      } else if (message.type === 'result' && message.id === publishId) {
        publishResult = message;
      } else if (message.type === 'capability') {
        send(child, { protocol: 1, pluginId: id, type: 'result', id: messageId(message), value: undefined });
      }
    }
    expect(publishError).toBeDefined();
    expect(String((publishError?.args as { message?: string }).message)).toContain(
      'events.publish failed',
    );
    send(child, {
      protocol: 1,
      pluginId: id,
      type: 'result',
      id: messageId(publishError as Message),
      value: undefined,
    });
    expect(publishResult).toMatchObject({ type: 'result', id: publishId });

    // T9: intercept/waterfall are unsupported across the process boundary and
    // must say so clearly (publish/subscribe remain available).
    const interceptId = randomUUID();
    send(child, {
      protocol: 1,
      pluginId: id,
      type: 'invoke',
      id: interceptId,
      method: 'GET',
      route: '/events-intercept',
      request: { params: {}, query: {}, body: null, headers: {} },
    });
    const interceptResult = await nextMessage(child);
    expect(interceptResult).toMatchObject({ type: 'result', id: interceptId });
    const errors = (interceptResult.value ?? {}) as Record<string, string>;
    expect(errors.intercept).toContain('暂不支持');
    expect(errors.waterfall).toContain('暂不支持');
  }, 20_000);

  it('streams a raw request body through the isolated bridge', async () => {
    const id = 'isolated-raw-echo';
    const manifest: PluginManifest = { id, name: 'Raw echo', version: '1.0.0' };
    const definition = await loadIsolatedPluginDefinition(id, entry, manifest);
    try {
      const route = definition.routes?.find((candidate) => candidate.path === '/raw/echo');
      expect(route?.kind).toBe('raw');
      const capture = captureReply();
      // Two writes so the body is delivered across multiple pulls.
      const body = Buffer.from('hello raw world');
      const request = rawRequest(body, { 'x-test': 'abc' });
      await (route?.handler as (req: RawHttpRequest, reply: RawHttpReply) => Promise<void>)(request, capture.reply);
      expect(capture.status).toBe(201);
      expect(capture.headers).toContainEqual(['x-raw', 'yes']);
      const output = Buffer.concat(capture.chunks).toString('utf8');
      expect(output).toBe(`len=${body.length};hdr=abc;hello raw world`);
    } finally {
      stopIsolatedPlugin(id);
    }
  }, 15_000);

  it('streams a raw response larger than one IPC message', async () => {
    const id = 'isolated-raw-burst';
    const manifest: PluginManifest = { id, name: 'Raw burst', version: '1.0.0' };
    const definition = await loadIsolatedPluginDefinition(id, entry, manifest);
    try {
      const route = definition.routes?.find((candidate) => candidate.path === '/raw/burst');
      const capture = captureReply();
      // 40 * 64KiB = 2.5MiB across ~40 IPC frames; each frame stays under 1MiB.
      const request = rawRequest(Buffer.alloc(0), {}, '?chunks=40&size=65536', 'GET');
      request.params = { '*': 'burst' };
      await (route?.handler as (req: RawHttpRequest, reply: RawHttpReply) => Promise<void>)(request, capture.reply);
      expect(capture.status).toBe(200);
      expect(Buffer.concat(capture.chunks).length).toBe(40 * 65536);
    } finally {
      stopIsolatedPlugin(id);
    }
  }, 15_000);

  it('honours raw backpressure without unbounded buffering', async () => {
    const id = 'isolated-raw-drain';
    const manifest: PluginManifest = { id, name: 'Raw drain', version: '1.0.0' };
    const definition = await loadIsolatedPluginDefinition(id, entry, manifest);
    try {
      const route = definition.routes?.find((candidate) => candidate.path === '/raw/drain');
      expect(route?.kind).toBe('raw');
      const capture = captureSlowReply();
      // 8MiB in 64KiB chunks. That is deliberately *twice* the worker's
      // RAW_MAX_QUEUE_BYTES (4MiB): without a working `drain()` every write is
      // queued synchronously and the bounded-queue guard trips; with it the
      // handler parks whenever the window closes.
      const request = rawRequest(Buffer.alloc(0), {}, '?chunks=128&size=65536', 'GET');
      request.params = { '*': 'drain' };
      const pump = capture.startDraining();
      await (route?.handler as (req: RawHttpRequest, reply: RawHttpReply) => Promise<void>)(
        request,
        capture.reply,
      );
      // The handler resolved, so every chunk was accepted; stop the pump.
      capture.stopDraining();
      await pump;
      const text = Buffer.concat(capture.chunks).toString('utf8');
      expect(text).toContain('stalls=');
      expect(capture.backpressureEvents()).toBeGreaterThan(0);
      expect(capture.maxBufferedBytes()).toBeLessThan(64 * 65536 * 4);
    } finally {
      stopIsolatedPlugin(id);
    }
  }, 20_000);

  it('surfaces a raw handler error before any output', async () => {
    const id = 'isolated-raw-error';
    const manifest: PluginManifest = { id, name: 'Raw error', version: '1.0.0' };
    const definition = await loadIsolatedPluginDefinition(id, entry, manifest);
    try {
      const route = definition.routes?.find((candidate) => candidate.path === '/raw/boom');
      const capture = captureReply();
      const request = rawRequest(Buffer.alloc(0), {}, '', 'GET');
      request.params = { '*': 'boom' };
      await expect((route?.handler as (req: RawHttpRequest, reply: RawHttpReply) => Promise<void>)(request, capture.reply))
        .rejects.toMatchObject({ message: 'raw boom', status: 502 });
      expect(capture.chunks).toHaveLength(0);
    } finally {
      stopIsolatedPlugin(id);
    }
  }, 15_000);

  it('cancels a hanging raw handler when the client disconnects', async () => {
    const id = 'isolated-raw-abort';
    const manifest: PluginManifest = { id, name: 'Raw abort', version: '1.0.0' };
    const definition = await loadIsolatedPluginDefinition(id, entry, manifest);
    try {
      const route = definition.routes?.find((candidate) => candidate.path === '/raw/hang');
      const capture = captureReply();
      const request = rawRequest(Buffer.alloc(0), {}, '', 'GET');
      request.params = { '*': 'hang' };
      const pending = (route?.handler as (req: RawHttpRequest, reply: RawHttpReply) => Promise<void>)(request, capture.reply);
      await new Promise((resolve) => setTimeout(resolve, 100));
      capture.closed();
      await expect(pending).resolves.toBeUndefined();
    } finally {
      stopIsolatedPlugin(id);
    }
  }, 15_000);

  it('streams a raw request body larger than one IPC message', async () => {
    const id = 'isolated-raw-bigreq';
    const manifest: PluginManifest = { id, name: 'Raw big request', version: '1.0.0' };
    const definition = await loadIsolatedPluginDefinition(id, entry, manifest);
    try {
      const route = definition.routes?.find((candidate) => candidate.path === '/raw/echo');
      const capture = captureReply();
      const body = Buffer.alloc(500_000, 0x62);
      const request = rawRequest(body, { 'x-test': 'big' });
      await (route?.handler as (req: RawHttpRequest, reply: RawHttpReply) => Promise<void>)(request, capture.reply);
      const output = Buffer.concat(capture.chunks);
      expect(output.subarray(output.length - body.length).equals(body)).toBe(true);
      expect(output.subarray(0, output.length - body.length).toString()).toBe('len=500000;hdr=big;');
    } finally {
      stopIsolatedPlugin(id);
    }
  }, 15_000);

  it('aborts a partial raw response when the handler fails after the head', async () => {
    const id = 'isolated-raw-late';
    const manifest: PluginManifest = { id, name: 'Raw late error', version: '1.0.0' };
    const definition = await loadIsolatedPluginDefinition(id, entry, manifest);
    try {
      const route = definition.routes?.find((candidate) => candidate.path === '/raw/boom-late');
      const capture = captureReply();
      const request = rawRequest(Buffer.alloc(0), {}, '', 'GET');
      request.params = { '*': 'boom-late' };
      await expect((route?.handler as (req: RawHttpRequest, reply: RawHttpReply) => Promise<void>)(request, capture.reply))
        .resolves.toBeUndefined();
      expect(capture.destroyed()).toBe(true);
    } finally {
      stopIsolatedPlugin(id);
    }
  }, 15_000);
});

it('invokes an isolated model provider with unwrapped results and propagates cancellation',async()=>{
  const id=`agent-provider-${randomUUID()}`;
  const plugin=await loadIsolatedPluginDefinition(id,fileURLToPath(new URL('../fixtures/agent-provider-rpc-plugin.mjs',import.meta.url)),{id,name:'Agent fixture',version:'1.0.0'});
  let provider: (LlmProvider & {aborted():Promise<boolean>}) | undefined;
  const context={registerExtension:(_point:string,value:typeof provider)=>{provider=value;return()=>undefined;}};
  try {
    await plugin.onRegister?.(context as unknown as PluginContext);
    if (!provider) throw new Error('模型扩展未注册');
    expect((await provider.listModels())[0]?.id).toBe('fixture');
    const options={callId:'stable-id',runId:'run-id',actorId:'owner'};
    const answer=await provider.complete({model:'fixture',messages:[]},options);
    expect(answer.parts).toEqual([{type:'text',text:'stable-id'}]);
    const controller=new AbortController();
    const result=provider.complete({model:'wait',messages:[]},{...options,signal:controller.signal});
    setTimeout(()=>controller.abort(),50);
    await expect(result).rejects.toThrow('aborted');
    await new Promise((resolve)=>setTimeout(resolve,50));
    expect(await provider.aborted()).toBe(true);
  } finally {stopIsolatedPlugin(id);}
},15000);
