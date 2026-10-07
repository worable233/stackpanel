import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CustomModelDefinition } from '@stackpanel/sdk';
import { decodeWire, encodeWire, RPC_MAX_BYTES, RPC_MAX_IN_FLIGHT, RPC_PROTOCOL, RPC_TIMEOUT_MS, wireError } from './protocol.ts';

type PluginHook = (value: unknown) => unknown | Promise<unknown>;
type RouteHook = (request: unknown, reply: unknown) => unknown | Promise<unknown>;

const entry = process.env.STACKPANEL_PLUGIN_ENTRY;
if (!entry) throw new Error('STACKPANEL_PLUGIN_ENTRY is required');
const pluginId = process.env.STACKPANEL_PLUGIN_ID;
if (!pluginId) throw new Error('STACKPANEL_PLUGIN_ID is required');

const mod = (await import(`${pathToFileURL(path.resolve(entry)).href}?isolated=${Date.now()}`)) as Record<string, unknown>;
const manifest = JSON.parse(process.env.STACKPANEL_PLUGIN_MANIFEST ?? '{}') as { export?: string; id?: string; name?: string; version?: string; [key: string]: unknown };
const definition = (mod[manifest.export ?? 'default'] ?? mod.default) as {
  routes?: Array<{ method: string; path: string; kind?: string; auth?: string; permission?: string; cors?: unknown; timeout?: number | false; bodyLimit?: number; handler: RouteHook }>;
  customModels?: CustomModelDefinition[];
  inject?: string[];
  eventListeners?: Array<{ topic: string; handler: (payload: unknown) => void }>;
  onRegister?: PluginHook;
  onActivate?: PluginHook;
  onDeactivate?: PluginHook;
};

if (!definition || !Array.isArray(definition.routes)) throw new Error('isolated plugin definition is invalid');
const unsupported: string[] = [];
if (definition.routes.some((route) => route.kind === 'raw')) unsupported.push('raw routes');

const routes = definition.routes.map(({ handler: _handler, ...route }) => route);
const modelDescriptors: Array<Record<string, unknown>> = [];
for (const model of definition.customModels ?? []) {
  try {
    modelDescriptors.push({
      kind: model.kind,
      label: model.label,
      ...(model.permission !== undefined ? { permission: model.permission } : {}),
      ...(model.readPermission !== undefined ? { readPermission: model.readPermission } : {}),
      ...(model.scoped !== undefined ? { scoped: model.scoped } : {}),
      ...(model.indexes !== undefined ? { indexes: model.indexes } : {}),
      ...(model.finalizers !== undefined ? { finalizers: model.finalizers } : {}),
      ...(model.retention !== undefined ? { retention: model.retention } : {}),
      schema: z.toJSONSchema(model.schema),
    });
  } catch {
    unsupported.push('custom model schema');
    break;
  }
}

const subscriptions = new Map<string, (payload: unknown) => void>();
const declarativeSubscriptions = new Set<string>();
const jobs = new Map<string, (payload: unknown) => Promise<void> | void>();
const finalizers = new Map<string, (instance: unknown) => Promise<void> | void>();
const serviceProxies = new Map<string, Record<string, unknown>>();
const serviceSyncValues = new Map<string, Record<string, unknown>>();
const extensionProxies = new Map<string, Array<{ pluginId: string; implementation: Record<string, unknown> }>>();
const pendingRegistrations: Array<Promise<unknown>> = [];
const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
const pendingStateLocks = new Map<string, () => Promise<void>>();
const effects: Array<() => void> = [];
const MAX_IPC_BYTES = RPC_MAX_BYTES;
const MAX_IN_FLIGHT = RPC_MAX_IN_FLIGHT;

function sendHost(message: Record<string, unknown>): void {
  if (!process.send) throw new Error('isolated plugin host is disconnected');
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(encodeWire(message)), 'utf8');
  } catch {
    throw new Error('isolated plugin RPC message is not serializable');
  }
  if (size > MAX_IPC_BYTES) throw new Error('isolated plugin RPC message exceeds IPC limit');
  process.send(encodeWire(message) as Record<string, unknown>, (error) => {
    if (error) process.exitCode = 1;
  });
}

sendHost({ protocol: RPC_PROTOCOL, pluginId, type: 'ready', routes, ...(modelDescriptors.length > 0 ? { models: modelDescriptors } : {}), ...(definition.inject?.length ? { inject: definition.inject } : {}), ...(unsupported.length > 0 ? { unsupported } : {}) });

function callHost(capability: string, args: unknown): Promise<unknown> {
  if (pending.size >= MAX_IN_FLIGHT) return Promise.reject(new Error('isolated plugin RPC concurrency limit exceeded'));
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      try { sendHost({ protocol: RPC_PROTOCOL, pluginId, type: 'cancel', id }); } catch { /* disconnect path */ }
      reject(Object.assign(new Error(`RPC capability ${capability} timed out`), { code: 'rpc.timeout', status: 504 }));
    }, RPC_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    try {
    sendHost({ protocol: RPC_PROTOCOL, pluginId, type: 'capability', id, capability, args });
    } catch (error) {
    clearTimeout(timer);
    pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function modelKind(model: unknown): string {
  if (!model || typeof model !== 'object' || typeof (model as { kind?: unknown }).kind !== 'string') {
    throw new Error('自定义模型引用无效');
  }
  const kind = (model as { kind: string }).kind;
  if (!(definition.customModels ?? []).some((candidate) => candidate.kind === kind)) {
    throw new Error(`未声明的自定义模型：${kind}`);
  }
  return kind;
}

function validateModelPayload(model: unknown, payload: unknown): unknown {
  const schema = (model as { schema?: { safeParse?: (value: unknown) => { success: boolean; data?: unknown; error?: { issues?: Array<{ path?: unknown[]; message?: string }> } } } }).schema;
  if (!schema || typeof schema.safeParse !== 'function') throw new Error('自定义模型 schema 无效');
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    const issue = parsed.error?.issues?.[0];
    throw new Error(`数据校验失败：${issue ? `${(issue.path ?? []).join('.')} ${issue.message ?? ''}` : '未知错误'}`);
  }
  return parsed.data;
}

function reviveInstance(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const instance = value as Record<string, unknown>;
  for (const field of ['createdAt', 'updatedAt', 'deletionTimestamp']) {
    if (typeof instance[field] === 'string') instance[field] = new Date(instance[field]);
  }
  return instance;
}

function implementationShape(implementation: unknown): { methods: string[]; values: Record<string, unknown> } {
  if (!implementation || typeof implementation !== 'object') throw new Error('扩展实现必须是对象');
  const methods = new Set<string>();
  let current: object | null = implementation as object;
  while (current && current !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(current)) {
      if (key === 'constructor') continue;
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (typeof descriptor?.value === 'function' && /^[A-Za-z][A-Za-z0-9_$]{0,127}$/.test(key)) methods.add(key);
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(implementation)) {
    if (typeof value !== 'function') values[key] = value;
  }
  if (methods.size > 128) throw new Error('扩展实现方法数量超出限制');
  return { methods: [...methods], values };
}

function queueRegistration(capability: string, args: unknown): void {
  pendingRegistrations.push(callHost(capability, args));
}

const extensions = {
  get: (model: unknown, name: string) => callHost('extensions.get', { kind: modelKind(model), name }).then(reviveInstance),
  list: (model: unknown, query: unknown) => callHost('extensions.list', { kind: modelKind(model), query }).then((result) => {
    const value = result as { items?: unknown[] };
    return { ...value, items: (value.items ?? []).map(reviveInstance) };
  }),
  listAll: (model: unknown, query?: unknown) => callHost('extensions.listAll', { kind: modelKind(model), query }).then((items) => (items as unknown[]).map(reviveInstance)),
  create: (model: unknown, spec: unknown, options?: unknown) => callHost('extensions.create', { kind: modelKind(model), spec: validateModelPayload(model, spec), options }).then(reviveInstance),
  update: (model: unknown, name: string, spec: unknown, options?: unknown) => callHost('extensions.update', { kind: modelKind(model), name, spec: validateModelPayload(model, spec), options }).then(reviveInstance),
  updateWhere: (model: unknown, where: unknown, patch: unknown) => callHost('extensions.updateWhere', { kind: modelKind(model), where, patch }),
  delete: (model: unknown, name: string) => callHost('extensions.delete', { kind: modelKind(model), name }).then(() => undefined),
  registerFinalizer: (model: unknown, name: string, handler: (instance: unknown) => Promise<void> | void) => {
    const token = `finalizer:${randomUUID()}`;
    finalizers.set(token, handler);
    queueRegistration('extensions.registerFinalizer', { kind: modelKind(model), name, token });
    const dispose = () => {
      finalizers.delete(token);
      void callHost('extensions.unregisterFinalizer', { token });
    };
    return dispose;
  },
};

function provideService(name: string, implementation: unknown): () => void {
  const token = `service:${randomUUID()}`;
  queueRegistration('services.provide', { name, token, ...implementationShape(implementation) });
  return () => { void callHost('services.unregister', { token }); };
}

function registerExtension(pointId: string, implementation: unknown): () => void {
  const token = `extension:${randomUUID()}`;
  queueRegistration('extensions.register', { pointId, token, ...implementationShape(implementation) });
  return () => { void callHost('extensions.unregister', { token }); };
}

const context = {
  manifest,
  logger: {
    info: (message: string) => { void callHost('logger.info', { message }); },
    warn: (message: string) => { void callHost('logger.warn', { message }); },
    error: (message: string) => { void callHost('logger.error', { message }); },
  },
  media: {
    register: (input: unknown) => callHost('media.register', input),
    unregister: (input: unknown) => callHost('media.unregister', input),
    unregisterResource: (resourceType: string, resourceId: string) => callHost('media.unregisterResource', { resourceType, resourceId }),
  },
  events: {
    publish: (topic: string, payload?: unknown) => {
      void callHost('events.publish', { topic, payload }).catch(() => undefined);
    },
    subscribe: (topic: string, handler: (payload: unknown) => void) => {
      const token = `event:${randomUUID()}`;
      subscriptions.set(token, handler);
      void callHost('events.subscribe', { topic, token }).catch(() => subscriptions.delete(token));
      return () => { subscriptions.delete(token); void callHost('events.unsubscribe', { token }); };
    },
    intercept: () => { throw new Error('ctx.events.intercept 暂不支持跨进程同步协议'); },
    waterfall: () => { throw new Error('ctx.events.waterfall 暂不支持跨进程同步协议'); },
  },
  jobs: {
    enqueue: (name: string, payload: unknown, options?: unknown) => callHost('jobs.enqueue', { name, payload, options }),
    schedule: (name: string, schedule: unknown, payload?: unknown) => callHost('jobs.schedule', { name, schedule, payload }),
    handle: (name: string, handler: (payload: unknown) => Promise<void> | void) => {
      const token = `job:${randomUUID()}`;
      jobs.set(token, handler);
      void callHost('jobs.handle', { name, token }).catch(() => jobs.delete(token));
      return () => { jobs.delete(token); void callHost('jobs.unhandle', { token }); };
    },
  },
  state: {
    ...serviceProxy('state', ['get', 'consume', 'set', 'del', 'incr', 'decr', 'acquire', 'release']),
    withLock: (key: string, ttlMs: number, fn: () => Promise<void>) => {
      const token = `state-lock:${randomUUID()}`;
      pendingStateLocks.set(token, fn);
      return callHost('state.withLock', { key, ttlMs, token }).finally(() => pendingStateLocks.delete(token));
    },
  },
  auth: serviceProxy('auth', ['verifyPassword', 'registerUser', 'issueSession', 'revokeSession', 'revokeAllSessions', 'sessionCookieConfig', 'hasPermission', 'listUserGroups', 'getUser', 'getUserByEmail', 'listUsersByIds', 'resolvePlatformToken', 'inspectPlatformToken', 'listPlatformTokens', 'listAllPlatformTokens', 'listPlatformTokensByScope', 'createPlatformToken', 'updatePlatformToken', 'ownsPlatformToken', 'deletePlatformToken', 'audit']),
  notifications: serviceProxy('notifications', ['create', 'upsert', 'listForUser', 'unreadCount', 'markRead', 'markAllRead']),
  secrets: serviceProxy('secrets', ['isAvailable', 'get', 'set', 'remove']),
  payments: serviceProxy('payments', ['listPaymentMethods', 'createRecord', 'initiate', 'create', 'settle', 'cancelExternalPayment', 'cancelTopUp', 'listTopUps', 'getProviderConfig', 'listByOrderIds', 'listChannelMethods', 'sweepExpired', 'confirmManual', 'cancelManual']),
  wallet: serviceProxy('wallet', ['getAccount', 'debit', 'credit', 'adjust', 'listAccounts', 'listLedger']),
  fx: serviceProxy('fx', ['quote', 'getRate', 'listRates']),
  extensions,
  registerExtension,
  provide: provideService,
  getService: <T>(name: string) => serviceProxies.get(name) as T | undefined,
  requireService: <T>(name: string) => {
    const service = serviceProxies.get(name);
    if (!service) throw new Error(`服务 ${name} 不可用`);
    return service as T;
  },
  getExtensions: <T>(pointId: string) => (extensionProxies.get(pointId) ?? []).map((entry) => entry.implementation as T),
  getExtensionsWithOwner: <T>(pointId: string) => (extensionProxies.get(pointId) ?? []).map((entry) => ({ pluginId: entry.pluginId, implementation: entry.implementation as T })),
  tx: async (fn: (tx: unknown) => Promise<unknown>) => {
    const txId = String(await callHost('tx.begin', {}));
    const tx = {
      wallet: {
        debit: (...args: unknown[]) => callHost('tx.wallet.debit', { txId, userId: args[0], amount: args[1], currency: args[2], ref: args[3] }),
        credit: (...args: unknown[]) => callHost('tx.wallet.credit', { txId, userId: args[0], amount: args[1], currency: args[2], ref: args[3] }),
      },
      payments: {
        createRecord: (input: unknown) => callHost('tx.payments.createRecord', { txId, input }),
      },
      extensions: {
        get: (model: unknown, name: string) => callHost('tx.extensions.get', { txId, kind: modelKind(model), name }).then(reviveInstance),
        list: (model: unknown, query: unknown) => callHost('tx.extensions.list', { txId, kind: modelKind(model), query }).then((result) => {
          const value = result as { items?: unknown[] };
          return { ...value, items: (value.items ?? []).map(reviveInstance) };
        }),
        listAll: (model: unknown, query?: unknown) => callHost('tx.extensions.listAll', { txId, kind: modelKind(model), query }).then((items) => (items as unknown[]).map(reviveInstance)),
        create: (model: unknown, spec: unknown, options?: unknown) => callHost('tx.extensions.create', { txId, kind: modelKind(model), spec: validateModelPayload(model, spec), options }).then(reviveInstance),
        update: (model: unknown, name: string, spec: unknown, options?: unknown) => callHost('tx.extensions.update', { txId, kind: modelKind(model), name, spec: validateModelPayload(model, spec), options }).then(reviveInstance),
        updateWhere: (model: unknown, where: unknown, patch: unknown) => callHost('tx.extensions.updateWhere', { txId, kind: modelKind(model), where, patch }),
        delete: (model: unknown, name: string) => callHost('tx.extensions.delete', { txId, kind: modelKind(model), name }).then(() => undefined),
        registerFinalizer: () => { throw new Error('事务中不允许注册 finalizer'); },
      },
    };
    try {
      const value = await fn(tx);
      await callHost('tx.commit', { txId });
      return value;
    } catch (error) {
      await callHost('tx.rollback', { txId }).catch(() => undefined);
      throw error;
    }
  },
  effect: (fn: (collect: (disposable: () => void) => void) => unknown) => {
    const local: Array<() => void> = [];
    const result = fn((disposable) => local.push(disposable));
    if (typeof result === 'function') local.push(result as () => void);
    const effectDispose = () => {
      for (const dispose of [...local].reverse()) dispose();
    };
    effects.push(effectDispose);
    return () => {
      effectDispose();
      const index = effects.indexOf(effectDispose);
      if (index >= 0) effects.splice(index, 1);
    };
  },
};

async function registerDeclarativeListeners(): Promise<void> {
  for (const listener of definition.eventListeners ?? []) {
    const token = `listener:${randomUUID()}`;
    subscriptions.set(token, listener.handler);
    try {
      await callHost('events.subscribe', { topic: listener.topic, token });
      declarativeSubscriptions.add(token);
    } catch (error) {
      subscriptions.delete(token);
      throw error;
    }
  }
}

async function unregisterDeclarativeListeners(): Promise<void> {
  for (const token of declarativeSubscriptions) {
    subscriptions.delete(token);
    await callHost('events.unsubscribe', { token }).catch(() => undefined);
  }
  declarativeSubscriptions.clear();
}

function rejectPending(error: Error): void {
  for (const request of pending.values()) request.reject(error);
  pending.clear();
}

process.once('disconnect', () => rejectPending(new Error('isolated plugin host disconnected')));
process.once('exit', () => rejectPending(new Error('isolated plugin worker exited')));

function serviceProxy(service: string, methods: string[]): Record<string, (...args: unknown[]) => unknown> {
  return Object.fromEntries(methods.map((method) => [method, (...args: unknown[]) => {
    const snapshot = serviceSyncValues.get(service);
    if (snapshot && Object.prototype.hasOwnProperty.call(snapshot, method)) return snapshot[method];
    return callHost(`${service}.${method}`, args);
  }])) as Record<string, (...args: unknown[]) => unknown>;
}

process.on('message', async (raw: unknown) => {
  try {
    if (Buffer.byteLength(JSON.stringify(encodeWire(raw)), 'utf8') > MAX_IPC_BYTES) return;
  } catch {
    return;
  }
  const message = decodeWire(raw) as {
    protocol?: number;
    pluginId?: string;
    type?: string;
    id?: string;
    method?: string;
    context?: unknown;
    route?: string;
    request?: unknown;
    phase?: string;
    token?: string;
    payload?: unknown;
    error?: { message: string };
    value?: unknown;
  };
  if (message?.protocol !== RPC_PROTOCOL || message.pluginId !== pluginId) return;
  if (!message.id && message.type !== 'event') return;
  const requestId = message.id as string;
  if (message.type === 'result') {
    const waiter = pending.get(requestId);
    if (!waiter) return;
    pending.delete(requestId);
    clearTimeout(waiter.timer);
    if (message.error) {
      const error = Object.assign(new Error(message.error.message), message.error);
      waiter.reject(error);
    } else waiter.resolve(message.value);
    return;
  }
  if (message.type === 'cancel') {
    const waiter = pending.get(requestId);
    if (waiter) { clearTimeout(waiter.timer); pending.delete(requestId); waiter.reject(new Error('RPC request cancelled')); }
    return;
  }
  if (message.type === 'event') {
    const listener = subscriptions.get(message.token ?? '');
    if (listener) {
      try {
        listener(message.payload);
      } catch (error) {
        void callHost('logger.error', {
          message: `isolated event listener failed: ${String(error instanceof Error ? error.message : error).slice(0, 8192)}`,
        }).catch(() => undefined);
      }
    }
    return;
  }
  if (message.type === 'job') {
    try {
      const handler = jobs.get(message.token ?? '');
      if (!handler) throw new Error('isolated job handler is not registered');
      await handler(message.payload);
      sendHost({ protocol: 1, pluginId, type: 'result', id: requestId, value: undefined });
    }
    catch (error) { sendHost({ protocol: RPC_PROTOCOL, pluginId, type: 'result', id: requestId, error: wireError(error) }); }
    return;
  }
  if (message.type === 'state-lock') {
    try {
      const handler = pendingStateLocks.get(message.token ?? '');
      pendingStateLocks.delete(message.token ?? '');
      if (!handler) throw new Error('isolated state lock callback is not registered');
      await handler();
      sendHost({ protocol: 1, pluginId, type: 'result', id: requestId, value: undefined });
    } catch (error) {
      sendHost({ protocol: RPC_PROTOCOL, pluginId, type: 'result', id: requestId, error: wireError(error) });
    }
    return;
  }
  if (message.type === 'finalizer') {
    try {
      const handler = finalizers.get(message.token ?? '');
      if (!handler) throw new Error('isolated finalizer is not registered');
      await handler(message.payload);
      sendHost({ protocol: 1, pluginId, type: 'result', id: requestId, value: undefined });
    } catch (error) {
      sendHost({ protocol: RPC_PROTOCOL, pluginId, type: 'result', id: requestId, error: wireError(error) });
    }
    return;
  }
  if (message.type === 'service') {
    try {
      const implementation = serviceProxies.get(message.token ?? '');
      const method = implementation?.[String(message.method ?? '')];
      if (typeof method !== 'function') throw new Error('isolated service method is not registered');
      const result = await method(...(Array.isArray(message.payload) ? message.payload : []));
      sendHost({ protocol: 1, pluginId, type: 'result', id: requestId, value: result });
    } catch (error) {
      sendHost({ protocol: RPC_PROTOCOL, pluginId, type: 'result', id: requestId, error: wireError(error) });
    }
    return;
  }
  if (message.type === 'lifecycle') {
    try {
      const lifecycleContext = message.context as {
        services?: Array<{ name: string; methods: string[]; values?: Record<string, unknown>; syncValues?: Record<string, unknown> }>;
        extensions?: Array<{ pointId: string; ownerId: string; index: number; methods: string[]; values?: Record<string, unknown> }>;
      } | undefined;
      const bindings = lifecycleContext?.services ?? [];
      for (const binding of bindings) {
        const proxy: Record<string, unknown> = Object.assign(Object.create(null) as Record<string, unknown>, binding.values ?? {});
        for (const method of binding.methods) {
          proxy[method] = (...args: unknown[]) => callHost('services.invoke', { name: binding.name, method, args });
        }
        serviceProxies.set(binding.name, proxy);
        serviceSyncValues.set(binding.name, binding.syncValues ?? {});
      }
      extensionProxies.clear();
      for (const binding of lifecycleContext?.extensions ?? []) {
        const proxy: Record<string, unknown> = Object.assign(Object.create(null) as Record<string, unknown>, binding.values ?? {});
        for (const method of binding.methods) {
          proxy[method] = (...args: unknown[]) => callHost('extensions.invoke', {
            pointId: binding.pointId,
            ownerId: binding.ownerId,
            index: binding.index,
            method,
            args,
          });
        }
        const list = extensionProxies.get(binding.pointId) ?? [];
        list.push({ pluginId: binding.ownerId, implementation: proxy });
        extensionProxies.set(binding.pointId, list);
      }
      const hook = message.phase === 'register' ? definition.onRegister : message.phase === 'activate' ? definition.onActivate : definition.onDeactivate;
      if (message.phase === 'activate') await registerDeclarativeListeners();
      if (hook) await hook(context);
      if (pendingRegistrations.length > 0) {
        const registrations = pendingRegistrations.splice(0);
        await Promise.all(registrations);
      }
      if (message.phase === 'deactivate') {
        await unregisterDeclarativeListeners();
        for (const dispose of [...effects].reverse()) dispose();
        effects.length = 0;
        subscriptions.clear();
        jobs.clear();
        finalizers.clear();
        pendingStateLocks.clear();
        serviceProxies.clear();
        serviceSyncValues.clear();
        extensionProxies.clear();
}
      sendHost({ protocol: 1, pluginId, type: 'result', id: requestId, value: undefined });
    } catch (error) { sendHost({ protocol: RPC_PROTOCOL, pluginId, type: 'result', id: requestId, error: wireError(error) }); }
    return;
  }
  if (message.type !== 'invoke') return;
  const route = definition.routes?.find((candidate) => candidate.method === message.method && candidate.path === message.route);
  if (!route) {
    sendHost({ protocol: 1, pluginId, type: 'result', id: requestId, error: { message: 'isolated route not found' } });
    return;
  }
  try {
    let status: number | undefined;
    let sent = false;
    let payload: unknown;
    const value = await route.handler(message.request as never, {
      code: (next: number) => { status = next; return undefined as never; },
      send: (next: unknown) => { sent = true; payload = next; },
    });
    sendHost({ protocol: 1, pluginId, type: 'result', id: requestId, value: sent ? undefined : value, ...(sent || status !== undefined ? { response: { ...(status !== undefined ? { status } : {}), ...(sent ? { payload } : {}) } } : {}) });
  } catch (error) {
    const candidate = error as { code?: unknown; status?: unknown };
    sendHost({ protocol: 1, pluginId, type: 'result', id: requestId, error: { message: String(error instanceof Error ? error.message : error), ...(typeof candidate.code === 'string' ? { code: candidate.code } : {}), ...(typeof candidate.status === 'number' ? { status: candidate.status } : {}) } });
  }
});
