import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import type { PluginDefinition, PluginManifest, PluginRoute, HttpRequest, HttpReply, PluginContext, JobOptions, JobSchedule, ExtensionTransaction, CustomModelDefinition } from '@stackpanel/sdk';
import { decodeWire, encodeWire, RPC_MAX_BYTES, RPC_MAX_IN_FLIGHT, RPC_PROTOCOL, RPC_TIMEOUT_MS, wireError } from './protocol.ts';

type ModelDescriptor = {
  kind: string;
  label: string;
  permission?: string;
  readPermission?: string;
  scoped?: boolean;
  indexes?: Array<{ fields: string[]; unique?: boolean; types: Record<string, 'string' | 'integer' | 'number' | 'boolean'> }>;
  finalizers?: string[];
  retention?: 'delete' | 'retain';
  schema: unknown;
};
type Ready = { protocol: 1; pluginId: string; type: 'ready'; routes: Array<Record<string, unknown>>; models?: ModelDescriptor[]; inject?: string[]; unsupported?: string[] };
type Result = { protocol: 1; pluginId: string; type: 'result'; id: string; value?: unknown; response?: { status?: number; payload?: unknown }; error?: { message: string; code?: string; status?: number } };
type Capability = { protocol: 1; pluginId: string; type: 'capability'; id: string; capability: string; args: unknown };
type Lifecycle = { protocol: 1; pluginId: string; type: 'lifecycle'; id: string; phase: 'register' | 'activate' | 'deactivate' };
type Cancel = { protocol: 1; pluginId: string; type: 'cancel'; id: string };

const SYNC_SERVICE_METHODS: Record<string, readonly string[]> = {
  auth: ['sessionCookieConfig'],
  secrets: ['isAvailable'],
  payments: ['listPaymentMethods'],
};

interface IsolatedWorker {
  child: ChildProcess;
  pending: Map<string, { resolve: (value: Result) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>;
  context?: PluginContext;
  disposers: Map<string, () => void>;
  transactions: Map<string, {
    tx: ExtensionTransaction;
    finish: (commit: boolean) => void;
    run: Promise<unknown>;
    timeout: NodeJS.Timeout;
  }>;
  capabilityRequests: Set<string>;
  models: Map<string, CustomModelDefinition>;
  allowedServices: Set<string>;
  allowedExtensions: Set<string>;
}

const workers = new Map<string, IsolatedWorker>();
const workerSpecs = new Map<string, { entry: string; manifest: PluginManifest; models: Map<string, CustomModelDefinition>; allowedServices: Set<string>; allowedExtensions: Set<string> }>();
let workerExitHandler: ((id: string) => void) | undefined;
export function setIsolatedWorkerExitHandler(handler: (id: string) => void): void { workerExitHandler = handler; }
const MAX_IPC_BYTES = RPC_MAX_BYTES;
const MAX_IN_FLIGHT = RPC_MAX_IN_FLIGHT;

function workerModule(): string {
  const js = new URL('./worker.js', import.meta.url);
  return fileURLToPath(existsSync(fileURLToPath(js)) ? js : new URL('./worker.ts', import.meta.url));
}

function workerExecArgv(): string[] {
  const allowed: string[] = [];
  for (let index = 0; index < process.execArgv.length; index += 1) {
    const arg = process.execArgv[index];
    if (arg === '--import' || arg === '--loader') {
      const value = process.execArgv[index + 1];
      if (value) {
        allowed.push(arg, value);
        index += 1;
      }
    } else if (arg?.startsWith('--import=') || arg?.startsWith('--loader=')) {
      allowed.push(arg);
    }
  }
  if (!allowed.some((arg) => arg.startsWith('--max-old-space-size'))) {
    allowed.push(`--max-old-space-size=${Math.max(64, Number(process.env.STACKPANEL_PLUGIN_MAX_OLD_SPACE_MB ?? 256))}`);
  }
  return allowed;
}

async function startWorker(id: string, entry: string, manifest: PluginManifest): Promise<Ready> {
  const child = fork(workerModule(), [], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: {
      NODE_ENV: process.env.NODE_ENV ?? 'production',
      STACKPANEL_PLUGIN_ID: id,
      STACKPANEL_PLUGIN_ENTRY: entry,
      STACKPANEL_PLUGIN_MANIFEST: JSON.stringify({
        ...manifest,
        export: (manifest as PluginManifest & { export?: string }).export ?? 'default',
      }),
    },
    execArgv: workerExecArgv(),
  });
  const pending = new Map<string, { resolve: (value: Result) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  const state: IsolatedWorker = {
    child,
    pending,
    disposers: new Map(),
    transactions: new Map(),
    capabilityRequests: new Set(),
    models: new Map(),
    allowedServices: new Set(),
    allowedExtensions: new Set(),
  };
  workers.set(id, state);
  const spec = workerSpecs.get(id);
  if (spec) {
    state.models = new Map(spec.models);
    state.allowedServices = new Set(spec.allowedServices);
    state.allowedExtensions = new Set(spec.allowedExtensions);
  }
  return await new Promise<Ready>((resolve, reject) => {
    let readySettled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      workers.delete(id);
      readySettled = true;
      reject(new Error(`isolated plugin ${id} failed to start`));
    }, 10_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      workers.delete(id);
      readySettled = true;
      reject(error);
    });
    child.on('message', (message: Ready | Result | Capability | Lifecycle | Cancel) => {
      let messageBytes: number;
      try {
        messageBytes = Buffer.byteLength(JSON.stringify(message), 'utf8');
      } catch {
        child.kill('SIGKILL');
        return;
      }
      if (messageBytes > MAX_IPC_BYTES) {
        child.kill('SIGKILL');
        return;
      }
      message = decodeWire(message) as Ready | Result | Capability | Lifecycle | Cancel;
      if (message.protocol !== RPC_PROTOCOL || message.pluginId !== id) return;
      if (message.type === 'ready') {
        clearTimeout(timer);
        readySettled = true;
        resolve(message);
        return;
      }
      if (message.type === 'capability') {
        if (state.capabilityRequests.size >= MAX_IN_FLIGHT || state.capabilityRequests.has(message.id)) {
          sendWorker(state.child, { protocol: 1, pluginId: id, type: 'result', id: message.id, error: { message: 'isolated plugin capability concurrency limit exceeded' } });
          return;
        }
        state.capabilityRequests.add(message.id);
        void Promise.race([
          handleCapability(id, state, message),
          new Promise<never>((_, reject) => setTimeout(() => {
            // The worker may still be awaiting this capability. Tell it to
            // abandon the pending promise before returning the timeout.
            try { sendWorker(state.child, { protocol: RPC_PROTOCOL, pluginId: id, type: 'cancel', id: message.id }); } catch { /* exit path */ }
            reject(Object.assign(new Error('isolated capability timed out'), { code: 'rpc.timeout', status: 504 }));
          }, RPC_TIMEOUT_MS)),
        ])
          .catch((error) => {
            sendWorker(state.child, { protocol: RPC_PROTOCOL, pluginId: id, type: 'result', id: message.id, error: wireError(error) });
          })
          .finally(() => state.capabilityRequests.delete(message.id));
        return;
      }
      if (message.type === 'cancel') {
        state.capabilityRequests.delete(message.id);
        return;
      }
      if (message.type === 'lifecycle') return;
      const request = state.pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      state.pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message) as Error & { code?: string; status?: number };
        if (message.error.code !== undefined) error.code = message.error.code;
        if (message.error.status !== undefined) error.status = message.error.status;
        request.reject(error);
      }
      else request.resolve(message);
    });
    child.once('exit', () => {
      if (!readySettled) {
        clearTimeout(timer);
        readySettled = true;
        reject(new Error(`isolated plugin ${id} exited before ready`));
      }
      workers.delete(id);
      for (const request of state.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error(`isolated plugin ${id} exited`));
      }
      state.pending.clear();
      state.capabilityRequests.clear();
      workerExitHandler?.(id);
    });
  });
}

async function handleCapability(id: string, state: IsolatedWorker, message: Capability): Promise<void> {
  const ctx = state.context;
  if (!ctx) throw new Error(`插件 ${id} 尚未激活`);
  const args = message.args as Record<string, unknown>;
  let value: unknown;
  if (message.capability === 'tx.begin') {
    const txId = randomUUID();
    let startTransaction!: () => void;
    let finishTransaction!: (commit: boolean) => void;
    const started = new Promise<void>((resolve) => { startTransaction = resolve; });
    const finished = new Promise<boolean>((resolve) => { finishTransaction = resolve; });
    let startupError: unknown;
    const timeout = setTimeout(() => finishTransaction(false), 30_000);
    const startGuard = setTimeout(() => startTransaction(), 10_000);
    const entry = { tx: undefined as unknown as ExtensionTransaction, finish: finishTransaction, run: Promise.resolve() as Promise<unknown>, timeout };
    state.transactions.set(txId, entry);
    const run = ctx.tx(async (tx) => {
      entry.tx = tx;
      startTransaction();
      const commit = await finished;
      if (!commit) throw new Error('isolated transaction rollback');
      return undefined;
    });
    entry.run = run;
    void run.catch((error) => { startupError = error; startTransaction(); });
    await started;
    clearTimeout(startGuard);
    if (startupError) throw startupError;
    value = txId;
    sendWorker(state.child, { protocol: 1, pluginId: id, type: 'result', id: message.id, value });
    return;
  }
  const transactionMatch = /^tx\.([a-z]+)\.([a-z]+)$/.exec(message.capability);
  if (transactionMatch) {
    const transaction = state.transactions.get(String(args.txId));
    if (!transaction) throw new Error('事务不存在或已结束');
    const operation = `${transactionMatch[1]}.${transactionMatch[2]}`;
    if (operation === 'wallet.debit') {
      value = await transaction.tx.wallet.debit(
        String(args.userId), Number(args.amount), String(args.currency), args.ref as never,
      );
    } else if (operation === 'wallet.credit') {
      value = await transaction.tx.wallet.credit(
        String(args.userId), Number(args.amount), String(args.currency), args.ref as never,
      );
    } else if (operation === 'payments.createRecord') {
      value = await transaction.tx.payments.createRecord(args.input as never);
    } else {
      throw new Error(`未知事务操作：${operation}`);
    }
    sendWorker(state.child, { protocol: 1, pluginId: id, type: 'result', id: message.id, value });
    return;
  }
  const extensionMatch = /^(tx\.)?extensions\.(get|list|listAll|create|update|updateWhere|delete)$/.exec(message.capability);
  if (extensionMatch) {
    const model = state.models.get(String(args.kind));
    if (!model) throw new Error(`未知或未声明的自定义模型：${String(args.kind)}`);
    const client = extensionMatch[1]
      ? state.transactions.get(String(args.txId))?.tx.extensions
      : ctx.extensions;
    if (!client) throw new Error('事务不存在或已结束');
    const method = client[extensionMatch[2] as keyof typeof client];
    if (typeof method !== 'function') throw new Error(`未知扩展操作：${message.capability}`);
    const invokeArgs = (() => {
      switch (extensionMatch[2]) {
        case 'get': return [model, String(args.name)];
        case 'list': return [model, args.query];
        case 'listAll': return [model, args.query];
        case 'create': return [model, args.spec, args.options];
        case 'update': return [model, String(args.name), args.spec, args.options];
        case 'updateWhere': return [model, args.where, args.patch];
        case 'delete': return [model, String(args.name)];
        default: throw new Error(`未知扩展操作：${message.capability}`);
      }
    })();
    value = await (method as (...input: unknown[]) => Promise<unknown>).apply(client, invokeArgs);
    sendWorker(state.child, { protocol: 1, pluginId: id, type: 'result', id: message.id, value });
    return;
  }
  if (message.capability === 'extensions.registerFinalizer') {
    const model = state.models.get(String(args.kind));
    if (!model) throw new Error(`未知或未声明的自定义模型：${String(args.kind)}`);
    const token = String(args.token);
    ctx.extensions.registerFinalizer(model, String(args.name), async (instance) => {
      await invokeWorker(id, 'finalizer', token, instance);
    });
    state.disposers.set(token, () => undefined);
    sendWorker(state.child, { protocol: 1, pluginId: id, type: 'result', id: message.id, value: undefined });
    return;
  }
  if (message.capability === 'tx.commit' || message.capability === 'tx.rollback') {
    const transaction = state.transactions.get(String(args.txId));
    if (!transaction) throw new Error('事务不存在或已结束');
    state.transactions.delete(String(args.txId));
    clearTimeout(transaction.timeout);
    transaction.finish(message.capability === 'tx.commit');
    if (message.capability === 'tx.commit') await transaction.run;
    else await transaction.run.catch(() => undefined);
    sendWorker(state.child, { protocol: 1, pluginId: id, type: 'result', id: message.id, value: undefined });
    return;
  }
  const loggerMatch = /^logger\.(info|warn|error)$/.exec(message.capability);
  if (loggerMatch) {
    const text = typeof args.message === 'string' ? args.message.slice(0, 8192) : String(args.message);
    ctx.logger[loggerMatch[1] as 'info' | 'warn' | 'error'](text);
    sendWorker(state.child, { protocol: 1, pluginId: id, type: 'result', id: message.id, value: undefined });
    return;
  }
  if (message.capability === 'services.provide') {
    const token = String(args.token);
    const implementation = workerProxy(id, token, Array.isArray(args.methods) ? args.methods.map(String) : [], (args.values ?? {}) as Record<string, unknown>);
    const dispose = ctx.provide(String(args.name), implementation);
    state.disposers.set(token, dispose);
    sendWorker(state.child, { protocol: 1, pluginId: id, type: 'result', id: message.id, value: undefined });
    return;
  }
  if (message.capability === 'services.unregister' || message.capability === 'extensions.unregister') {
    const token = String(args.token);
    state.disposers.get(token)?.();
    state.disposers.delete(token);
    sendWorker(state.child, { protocol: 1, pluginId: id, type: 'result', id: message.id, value: undefined });
    return;
  }
  if (message.capability === 'services.invoke') {
    const serviceName = String(args.name);
    if (!state.allowedServices.has(serviceName)) throw new Error(`服务未获插件声明授权：${serviceName}`);
    const service = ctx.getService<Record<string, unknown>>(serviceName);
    const method = service?.[String(args.method)];
    if (typeof method !== 'function') throw new Error(`服务方法不可用：${String(args.name)}.${String(args.method)}`);
    value = await method.apply(service, Array.isArray(args.args) ? args.args : []);
    sendWorker(state.child, { protocol: 1, pluginId: id, type: 'result', id: message.id, value });
    return;
  }
  if (message.capability === 'state.withLock') {
    const token = String(args.token);
    const acquired = await ctx.state.withLock(
      String(args.key),
      Number(args.ttlMs),
      async () => { await invokeWorker(id, 'state-lock', token, undefined); },
    );
    sendWorker(state.child, { protocol: 1, pluginId: id, type: 'result', id: message.id, value: acquired });
    return;
  }
  if (message.capability === 'extensions.invoke') {
    const pointId = String(args.pointId);
    const ownerId = String(args.ownerId);
    if (!state.allowedExtensions.has(`${pointId}\u0000${ownerId}`)) {
      throw new Error(`扩展点未获插件声明授权：${pointId}`);
    }
    const entries = ctx.getExtensionsWithOwner<Record<string, unknown>>(pointId);
    const candidates = entries.filter((entry) => entry.pluginId === ownerId);
    const implementation = candidates[Number(args.index)]?.implementation;
    const method = implementation?.[String(args.method)];
    if (typeof method !== 'function') throw new Error(`扩展方法不可用：${String(args.pointId)}.${String(args.method)}`);
    value = await method.apply(implementation, Array.isArray(args.args) ? args.args : []);
    sendWorker(state.child, { protocol: 1, pluginId: id, type: 'result', id: message.id, value });
    return;
  }
  if (message.capability === 'extensions.register') {
    const token = String(args.token);
    const implementation = workerProxy(id, token, Array.isArray(args.methods) ? args.methods.map(String) : [], (args.values ?? {}) as Record<string, unknown>);
    const dispose = ctx.registerExtension(String(args.pointId), implementation);
    state.disposers.set(token, dispose);
    sendWorker(state.child, { protocol: 1, pluginId: id, type: 'result', id: message.id, value: undefined });
    return;
  }
  const serviceMatch = /^([a-z]+)\.([a-zA-Z][a-zA-Z0-9]*)$/.exec(message.capability);
  if (serviceMatch && ['state', 'auth', 'notifications', 'secrets', 'payments', 'wallet', 'fx'].includes(serviceMatch[1] ?? '')) {
    const service = ctx[serviceMatch[1] as 'state' | 'auth' | 'notifications' | 'secrets' | 'payments' | 'wallet' | 'fx'] as unknown as Record<string, unknown>;
    const method = service[serviceMatch[2] ?? ''];
    if (typeof method !== 'function') throw new Error(`未知插件服务方法：${message.capability}`);
    value = await method.apply(service, Array.isArray(args) ? args : []);
    sendWorker(state.child, { protocol: 1, pluginId: id, type: 'result', id: message.id, value });
    return;
  }
  switch (message.capability) {
    case 'media.register': value = await ctx.media.register({ ...(args as Parameters<PluginContext['media']['register']>[0]), ownerPluginId: id }); break;
    case 'media.unregister': value = await ctx.media.unregister({ ...(args as Parameters<PluginContext['media']['unregister']>[0]), ownerPluginId: id }); break;
    case 'media.unregisterResource': value = await ctx.media.unregisterResource(String(args.resourceType), String(args.resourceId), id); break;
    case 'events.publish': value = ctx.events.publish(String(args.topic), args.payload); break;
    case 'events.subscribe': {
      const topic = String(args.topic);
      const token = typeof args.token === 'string' ? args.token : `${message.id}:${topic}`;
      const dispose = ctx.events.subscribe(topic, (payload) => {
        sendWorker(state.child, { protocol: 1, pluginId: id, type: 'event', token, payload });
      });
      state.disposers.set(token, dispose);
      value = token;
      break;
    }
    case 'events.unsubscribe': state.disposers.get(String(args.token))?.(); state.disposers.delete(String(args.token)); break;
    case 'jobs.enqueue': value = await ctx.jobs.enqueue(String(args.name), args.payload, args.options as JobOptions | undefined); break;
    case 'jobs.schedule': value = await ctx.jobs.schedule(String(args.name), args.schedule as JobSchedule, args.payload); break;
    case 'jobs.handle': {
      const token = typeof args.token === 'string' ? args.token : `${message.id}:${String(args.name)}`;
      const dispose = ctx.jobs.handle(String(args.name), async (payload) => {
        await invokeWorker(id, 'job', token, payload);
      });
      state.disposers.set(token, dispose);
      value = token;
      break;
    }
    case 'jobs.unhandle': state.disposers.get(String(args.token))?.(); state.disposers.delete(String(args.token)); break;
    default: throw new Error(`未知插件能力：${message.capability}`);
  }
  sendWorker(state.child, { protocol: 1, pluginId: id, type: 'result', id: message.id, value });
}

function sendWorker(child: ChildProcess, message: Record<string, unknown>): void {
  if (!child.connected) throw new Error('isolated plugin worker is disconnected');
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(encodeWire(message)), 'utf8');
  } catch {
    throw new Error('isolated plugin RPC message is not serializable');
  }
  if (size > MAX_IPC_BYTES) throw new Error('isolated plugin RPC message exceeds IPC limit');
  child.send(encodeWire(message) as Record<string, unknown>, (error) => {
    if (error) child.kill('SIGTERM');
  });
}

function implementationShape(implementation: unknown): { methods: string[]; values: Record<string, unknown> } {
  if (!implementation || typeof implementation !== 'object') return { methods: [], values: {} };
  const methods = new Set<string>();
  let current: object | null = implementation as object;
  while (current && current !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(current)) {
      if (key === 'constructor') continue;
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (typeof descriptor?.value === 'function') methods.add(key);
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(implementation)) {
    if (typeof value !== 'function') values[key] = value;
  }
  return { methods: [...methods], values };
}

function workerProxy(id: string, token: string, methods: string[], values: Record<string, unknown>): Record<string, unknown> {
  if (methods.length > 128) throw new Error('isolated implementation method count exceeds limit');
  const proxy: Record<string, unknown> = Object.assign(Object.create(null) as Record<string, unknown>, values);
  for (const method of methods) {
    if (!/^[A-Za-z][A-Za-z0-9_$]{0,127}$/.test(method)) throw new Error(`isolated implementation method name is invalid: ${method}`);
    proxy[method] = (...args: unknown[]) => invokeWorker(id, 'service', token, { method, payload: args });
  }
  return proxy;
}

function invokeWorker(id: string, kind: string, token: string, payload: unknown): Promise<Result> {
  const state = workers.get(id);
  if (!state || !state.child.connected) return Promise.reject(new Error(`isolated plugin ${id} is unavailable`));
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(requestId);
      try { sendWorker(state.child, { protocol: RPC_PROTOCOL, pluginId: id, type: 'cancel', id: requestId }); } catch { /* exit path */ }
      reject(Object.assign(new Error(`isolated plugin ${id} timed out`), { code: 'rpc.timeout', status: 504 }));
    }, RPC_TIMEOUT_MS);
    state.pending.set(requestId, { resolve, reject, timer });
    try {
      sendWorker(state.child, { protocol: 1, pluginId: id, type: kind, id: requestId, ...(kind === 'lifecycle' ? { phase: token, context: payload } : { token, payload }) });
    } catch (error) {
      clearTimeout(timer);
      state.pending.delete(requestId);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function invoke(id: string, method: string, route: string, request: HttpRequest): Promise<Result> {
  const state = workers.get(id);
  if (!state || !state.child.connected) return Promise.reject(new Error(`isolated plugin ${id} is unavailable`));
  if (state.pending.size >= MAX_IN_FLIGHT) return Promise.reject(new Error(`isolated plugin ${id} concurrency limit exceeded`));
  const serialized = JSON.stringify(request);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_IPC_BYTES) {
    return Promise.reject(new Error(`isolated plugin ${id} request exceeds IPC limit`));
  }
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(requestId);
      try { sendWorker(state.child, { protocol: RPC_PROTOCOL, pluginId: id, type: 'cancel', id: requestId }); } catch { /* exit path */ }
      reject(Object.assign(new Error(`isolated plugin ${id} timed out`), { code: 'rpc.timeout', status: 504 }));
    }, 10_000);
    state.pending.set(requestId, { resolve, reject, timer });
    try {
      sendWorker(state.child, { protocol: 1, pluginId: id, type: 'invoke', id: requestId, method, route, request });
    } catch (error) {
      clearTimeout(timer);
      state.pending.delete(requestId);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export async function loadIsolatedPluginDefinition(id: string, entry: string, manifest: PluginManifest): Promise<PluginDefinition> {
  const ready = await startWorker(id, entry, manifest);
  const unsupported = ready.unsupported?.filter((item) => item !== 'onRegister' && item !== 'onActivate' && item !== 'onDeactivate') ?? [];
  if (unsupported.length > 0) {
    stopIsolatedPlugin(id);
    throw new Error(`插件 ${id} 的 isolated 能力暂不支持：${unsupported.join('、')}`);
  }
  const state = workers.get(id);
  if (!state) throw new Error(`isolated plugin ${id} is unavailable`);
  state.allowedServices = new Set(ready.inject ?? []);
  state.allowedExtensions = new Set(
    (manifest.consumes ?? []).map((consumer) => `${consumer.extensionPoint}\u0000${consumer.pluginId}`),
  );
  workerSpecs.set(id, { entry, manifest, models: new Map(state.models), allowedServices: new Set(state.allowedServices), allowedExtensions: new Set(state.allowedExtensions) });
  const customModels: CustomModelDefinition[] = [];
  for (const descriptor of ready.models ?? []) {
    try {
      const model: CustomModelDefinition = {
        kind: descriptor.kind,
        label: descriptor.label,
        ...(descriptor.permission !== undefined ? { permission: descriptor.permission } : {}),
        ...(descriptor.readPermission !== undefined ? { readPermission: descriptor.readPermission } : {}),
        ...(descriptor.scoped !== undefined ? { scoped: descriptor.scoped } : {}),
        ...(descriptor.indexes !== undefined ? { indexes: descriptor.indexes } : {}),
        ...(descriptor.finalizers !== undefined ? { finalizers: descriptor.finalizers } : {}),
        ...(descriptor.retention !== undefined ? { retention: descriptor.retention } : {}),
        schema: z.fromJSONSchema(descriptor.schema as never),
      };
      customModels.push(model);
      state.models.set(model.kind, model);
    } catch (error) {
      stopIsolatedPlugin(id);
      throw new Error(`插件 ${id} 的模型 ${descriptor.kind} schema 无法跨进程序列化：${String(error)}`, { cause: error });
    }
  }
  const lifecycle = (phase: 'register' | 'activate' | 'deactivate') => async (ctx: PluginContext): Promise<void> => {
    const state = workers.get(id);
    if (!state) throw new Error(`isolated plugin ${id} is unavailable`);
    state.context = ctx;
    try {
      const services = (ready.inject ?? []).flatMap((name) => {
        const service = ctx.getService<Record<string, unknown>>(name);
        if (!service) return [];
        const shape = implementationShape(service);
        const syncValues: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
        for (const method of SYNC_SERVICE_METHODS[name] ?? []) {
          const candidate = service[method];
          if (typeof candidate === 'function') syncValues[method] = candidate.call(service);
        }
        return [{ name, ...shape, ...(Object.keys(syncValues).length > 0 ? { syncValues } : {}) }];
      });
      const extensions = (manifest.consumes ?? []).flatMap((consumer) => {
        const entries = ctx.getExtensionsWithOwner<Record<string, unknown>>(consumer.extensionPoint)
          .filter((entry) => entry.pluginId === consumer.pluginId);
        return entries.map((entry, index) => ({
          pointId: consumer.extensionPoint,
          ownerId: entry.pluginId,
          index,
          ...implementationShape(entry.implementation),
        }));
      });
      const result = await invokeWorker(id, 'lifecycle', phase, { services, extensions });
      if (result.error) throw new Error(result.error.message);
    } finally {
      if (phase === 'deactivate') {
        for (const dispose of state.disposers.values()) dispose();
        state.disposers.clear();
        for (const transaction of state.transactions.values()) {
          clearTimeout(transaction.timeout);
          transaction.finish(false);
        }
        state.transactions.clear();
      }
    }
  };
  const routes: PluginRoute[] = ready.routes.map((route) => ({
    ...route,
    handler: async (request: HttpRequest, _reply: HttpReply) => {
      const result = await invoke(id, String(route.method), String(route.path), request);
      if (result.response?.status !== undefined) _reply.code(result.response.status);
      if (result.response?.payload !== undefined) _reply.send(result.response.payload);
      return result.value;
    },
  })) as PluginRoute[];
  return {
    manifest,
    routes,
    ...(ready.inject !== undefined ? { inject: ready.inject } : {}),
    ...(customModels.length > 0 ? { customModels } : {}),
    ...(ready.unsupported?.includes('onRegister') ? {} : { onRegister: lifecycle('register') }),
    ...(ready.unsupported?.includes('onActivate') ? {} : { onActivate: lifecycle('activate') }),
    ...(ready.unsupported?.includes('onDeactivate') ? {} : { onDeactivate: lifecycle('deactivate') }),
  };
}

export function stopIsolatedPlugin(id: string): void {
  const state = workers.get(id);
  workers.delete(id);
  for (const dispose of state?.disposers.values() ?? []) dispose();
  for (const transaction of state?.transactions.values() ?? []) {
    clearTimeout(transaction.timeout);
    transaction.finish(false);
  }
  state?.transactions.clear();
  state?.child.kill('SIGTERM');
}

/** Recreate a quarantined worker before the runtime activates it again. */
export async function restartIsolatedPlugin(id: string): Promise<void> {
  const spec = workerSpecs.get(id);
  if (!spec || workers.has(id)) return;
  await startWorker(id, spec.entry, spec.manifest);
}

export function stopAllIsolatedPlugins(): void {
  for (const id of [...workers.keys()]) stopIsolatedPlugin(id);
}
