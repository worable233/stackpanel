import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { loadIsolatedPluginDefinition, stopIsolatedPlugin } from '../../src/plugins/isolated/host.ts';
import type { PluginManifest } from '@stackpanel/sdk';

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
  });
});
