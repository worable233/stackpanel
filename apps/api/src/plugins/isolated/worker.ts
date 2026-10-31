import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { formatMinorCurrency, toMinorUnits } from '@stackpanel/sdk';
import type { CustomModelDefinition } from '@stackpanel/sdk';
import {
  decodeWire,
  encodeWire,
  RPC_MAX_BYTES,
  RPC_MAX_IN_FLIGHT,
  RPC_MAX_RAW_STREAMS,
  RPC_PROTOCOL,
  RPC_TIMEOUT_MS,
  wireError,
  reviveWireError,
  RAW_CHUNK_BYTES,
  RAW_MAX_QUEUE_BYTES,
  RAW_WINDOW_BYTES,
} from './protocol.ts';
import type { RawInvokeRequest } from './raw-protocol.ts';

/**
 * Serialise a thrown error for the host side.
 *
 * Delegates to `wireError` instead of hand-rolling the literal: `details` and
 * the SDK error-class brand have to travel too, otherwise `isWalletError` /
 * `isPluginError` narrowing on the host silently takes the generic branch. The
 * human-readable `detail` also has to survive, or the host can only show the
 * machine code.
 */
const wireThrown = (error: unknown): ReturnType<typeof wireError> => wireError(error);

import { resolveMaxRssMb, startMemoryGuard } from './memory-guard.ts';

type PluginHook = (value: unknown) => unknown | Promise<unknown>;
type RouteHook = (request: unknown, reply: unknown) => unknown | Promise<unknown>;

const entry = process.env.STACKPANEL_PLUGIN_ENTRY;
if (!entry) throw new Error('STACKPANEL_PLUGIN_ENTRY is required');
const pluginId = process.env.STACKPANEL_PLUGIN_ID;
if (!pluginId) throw new Error('STACKPANEL_PLUGIN_ID is required');

// Start the RSS guard *before* importing the plugin so plugin top-level code
// cannot observe or interfere with it. Exit code 137 (128 + SIGKILL) is the
// conventional OOM signal the host's circuit breaker already understands.
const maxRssMb = resolveMaxRssMb(process.env.STACKPANEL_PLUGIN_MAX_RSS_MB);
startMemoryGuard({
  maxRssMb,
  onExceed: (rss) => {
    console.error(
      `[isolated-worker] ${pluginId} exceeded RSS ceiling: ${rss.toFixed(0)}MB > ${maxRssMb}MB`,
    );
    process.exit(137);
  },
});

const mod = (await import(
  `${pathToFileURL(path.resolve(entry)).href}?isolated=${Date.now()}`
)) as Record<string, unknown>;
const manifest = JSON.parse(process.env.STACKPANEL_PLUGIN_MANIFEST ?? '{}') as {
  export?: string;
  id?: string;
  name?: string;
  version?: string;
  [key: string]: unknown;
};
const definition = (mod[manifest.export ?? 'default'] ?? mod.default) as {
  routes?: Array<{
    method: string;
    path: string;
    kind?: string;
    auth?: string;
    permission?: string;
    cors?: unknown;
    timeout?: number | false;
    bodyLimit?: number;
    handler: RouteHook;
  }>;
  customModels?: CustomModelDefinition[];
  inject?: string[];
  // `definePlugin({ manifest, ... })` 把 requires/consumes/inject 写在嵌套的
  // manifest 里，也有插件直接平铺在定义顶层。隔离模式构造 extensions 与服务
  // 白名单时两种形态都要识别，否则声明过的能力会被当成未声明而静默拒掉
  // （外部症状：同一插件 trusted 正常、isolated 下报「未就绪」）。
  manifest?: {
    consumes?: Array<{ pluginId: string; extensionPoint: string; optional?: boolean }>;
    inject?: string[];
    /**
     * Open-platform capabilities the plugin declares.
     *
     * 必须跨进程序列化回宿主：宿主只有磁盘 manifest，而安装器生成的
     * manifest.json 只写权限/执行等字段，`capabilities` 只存在于插件定义里。
     * 漏传的后果是插件路由照常可用、`/api/v1/<capability.path>` 别名也挂上了，
     * 但 `pluginRuntime.listCapabilities()` 返回空 —— 于是 `/api/v1/capabilities`
     * 与 MCP `tools/list` 里看不到任何插件贡献的能力，Agent 无从调用。
     */
    capabilities?: Array<Record<string, unknown>>;
  };
  capabilities?: Array<Record<string, unknown>>;
  consumes?: Array<{ pluginId: string; extensionPoint: string; optional?: boolean }>;
  eventListeners?: Array<{ topic: string; handler: (payload: unknown) => void }>;
  onRegister?: PluginHook;
  onActivate?: PluginHook;
  onDeactivate?: PluginHook;
};

if (!definition || !Array.isArray(definition.routes))
  throw new Error('isolated plugin definition is invalid');
const unsupported: string[] = [];

const serviceControllers = new Map<string, AbortController>();
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

const subscriptions = new Map<
  string,
  (payload: unknown, meta?: { eventId?: string; topic?: string }) => void
>();
const declarativeSubscriptions = new Set<string>();
/** Count of failed `events.publish` RPCs (observability; never silent). */
let publishFailures = 0;
const jobs = new Map<string, (payload: unknown) => Promise<void> | void>();
const finalizers = new Map<string, (instance: unknown) => Promise<void> | void>();
const providedImplementations = new Map<string, Record<string, unknown>>();
const serviceProxies = new Map<string, Record<string, unknown>>();
const serviceSyncValues = new Map<string, Record<string, unknown>>();
/**
 * Rebuilt synchronous *predicates* (`notificationPolicy.declares(type)`).
 *
 * A predicate takes an argument and returns a value, so it cannot be shipped as a
 * value — the host ships the catalog behind it and the worker evaluates the same
 * exact/prefix match locally instead of paying an async hop per call.
 */
const serviceSyncPredicates = new Map<string, Record<string, unknown>>();

/** Rebuild the shipped predicate closures for one service. */
function buildSyncPredicates(input: Record<string, unknown>): Record<string, unknown> | null {
  const built: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const declaresInput = input['declares'] as { types?: unknown } | undefined;
  if (declaresInput && Array.isArray(declaresInput.types)) {
    const types = declaresInput.types.filter((type): type is string => typeof type === 'string');
    // Mirrors KernelNotificationPolicyService.declares exactly: an exact match, or
    // a `.*` wildcard matching anything under its prefix.
    built['declares'] = (type: unknown) => {
      const value = String(type);
      return types.some(
        (declared) =>
          declared === value ||
          (declared.endsWith('.*') && value.startsWith(declared.slice(0, -1))),
      );
    };
  }
  return Object.keys(built).length > 0 ? built : null;
}
const extensionProxies = new Map<
  string,
  Array<{ pluginId: string; implementation: Record<string, unknown> }>
>();
const pendingRegistrations: Array<Promise<unknown>> = [];
const pending = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
>();
const pendingStateLocks = new Map<string, () => Promise<void>>();
const effects: Array<() => void> = [];
const MAX_IPC_BYTES = RPC_MAX_BYTES;
const MAX_IN_FLIGHT = RPC_MAX_IN_FLIGHT;

function sendHost(message: Record<string, unknown>): void {
  if (!process.send) throw new Error('isolated plugin host is disconnected');
  // Encode once and reuse the result: `encodeWire` is the expensive half
  // (Buffer → base64), so encoding a second time just to hand the same object to
  // `send` doubled the per-frame cost of every IPC message, including each
  // 64 KiB raw chunk (ADR-0022 P13).
  let frame: unknown;
  let size: number;
  try {
    frame = encodeWire(message);
    size = Buffer.byteLength(JSON.stringify(frame), 'utf8');
  } catch {
    throw new Error('isolated plugin RPC message is not serializable');
  }
  if (size > MAX_IPC_BYTES) throw new Error('isolated plugin RPC message exceeds IPC limit');
  process.send(frame as Record<string, unknown>, (error) => {
    if (error) process.exitCode = 1;
  });
}

const declaredConsumes = definition.manifest?.consumes ?? definition.consumes ?? [];
const declaredInject = definition.manifest?.inject ?? definition.inject ?? [];
// 插件定义优先，磁盘 manifest 兜底：与 consumes 同理，安装器可能只写后者。
const declaredCapabilities: Array<Record<string, unknown>> =
  definition.manifest?.capabilities ??
  definition.capabilities ??
  (manifest['capabilities'] as Array<Record<string, unknown>> | undefined) ??
  [];

sendHost({
  protocol: RPC_PROTOCOL,
  pluginId,
  type: 'ready',
  routes,
  ...(modelDescriptors.length > 0 ? { models: modelDescriptors } : {}),
  ...(declaredInject.length > 0 ? { inject: declaredInject } : {}),
  ...(declaredConsumes.length > 0 ? { consumes: declaredConsumes } : {}),
  ...(declaredCapabilities.length > 0 ? { capabilities: declaredCapabilities } : {}),
  ...(unsupported.length > 0 ? { unsupported } : {}),
});

function callHost(capability: string, args: unknown): Promise<unknown> {
  if (pending.size >= MAX_IN_FLIGHT)
    return Promise.reject(new Error('isolated plugin RPC concurrency limit exceeded'));
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      try {
        sendHost({ protocol: RPC_PROTOCOL, pluginId, type: 'cancel', id });
      } catch {
        /* disconnect path */
      }
      reject(
        Object.assign(new Error(`RPC capability ${capability} timed out`), {
          code: 'rpc.timeout',
          status: 504,
        }),
      );
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
  if (
    !model ||
    typeof model !== 'object' ||
    typeof (model as { kind?: unknown }).kind !== 'string'
  ) {
    throw new Error('自定义模型引用无效');
  }
  const kind = (model as { kind: string }).kind;
  if (!(definition.customModels ?? []).some((candidate) => candidate.kind === kind)) {
    throw new Error(`未声明的自定义模型：${kind}`);
  }
  return kind;
}

function validateModelPayload(model: unknown, payload: unknown): unknown {
  const schema = (
    model as {
      schema?: {
        safeParse?: (value: unknown) => {
          success: boolean;
          data?: unknown;
          error?: { issues?: Array<{ path?: unknown[]; message?: string }> };
        };
      };
    }
  ).schema;
  if (!schema || typeof schema.safeParse !== 'function') throw new Error('自定义模型 schema 无效');
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    const issue = parsed.error?.issues?.[0];
    throw new Error(
      `数据校验失败：${issue ? `${(issue.path ?? []).join('.')} ${issue.message ?? ''}` : '未知错误'}`,
    );
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

function implementationShape(implementation: unknown): {
  methods: string[];
  values: Record<string, unknown>;
} {
  if (!implementation || typeof implementation !== 'object') throw new Error('扩展实现必须是对象');
  const methods = new Set<string>();
  let current: object | null = implementation as object;
  while (current && current !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(current)) {
      if (key === 'constructor') continue;
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (typeof descriptor?.value === 'function' && /^[A-Za-z][A-Za-z0-9_$]{0,127}$/.test(key))
        methods.add(key);
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
  get: (model: unknown, name: string) =>
    callHost('extensions.get', { kind: modelKind(model), name }).then(reviveInstance),
  list: (model: unknown, query: unknown) =>
    callHost('extensions.list', { kind: modelKind(model), query }).then((result) => {
      const value = result as { items?: unknown[] };
      return { ...value, items: (value.items ?? []).map(reviveInstance) };
    }),
  listAll: (model: unknown, query?: unknown) =>
    callHost('extensions.listAll', { kind: modelKind(model), query }).then((items) =>
      (items as unknown[]).map(reviveInstance),
    ),
  page: (model: unknown, query: unknown) =>
    callHost('extensions.page', { kind: modelKind(model), query }).then((result) => {
      const value = result as { items?: unknown[] };
      return { ...value, items: (value.items ?? []).map(reviveInstance) };
    }),
  getMany: (model: unknown, names: readonly string[]) =>
    callHost('extensions.getMany', { kind: modelKind(model), names }).then((result) => {
      // Maps do not survive JSON IPC; the host sends `[name, instance]` pairs.
      const map = new Map<string, unknown>();
      for (const entry of (result ?? []) as Array<[string, unknown]>) {
        map.set(String(entry[0]), reviveInstance(entry[1]));
      }
      return map;
    }),
  create: (model: unknown, spec: unknown, options?: unknown) =>
    callHost('extensions.create', {
      kind: modelKind(model),
      spec: validateModelPayload(model, spec),
      options,
    }).then(reviveInstance),
  update: (model: unknown, name: string, spec: unknown, options?: unknown) =>
    callHost('extensions.update', {
      kind: modelKind(model),
      name,
      spec: validateModelPayload(model, spec),
      options,
    }).then(reviveInstance),
  updateWhere: (model: unknown, where: unknown, patch: unknown) =>
    callHost('extensions.updateWhere', { kind: modelKind(model), where, patch }),
  delete: (model: unknown, name: string) =>
    callHost('extensions.delete', { kind: modelKind(model), name }).then(() => undefined),
  registerFinalizer: (
    model: unknown,
    name: string,
    handler: (instance: unknown) => Promise<void> | void,
  ) => {
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
  providedImplementations.set(token, implementation as Record<string, unknown>);
  queueRegistration('services.provide', { name, token, ...implementationShape(implementation) });
  return () => {
    providedImplementations.delete(token);
    void callHost('services.unregister', { token });
  };
}

function registerExtension(pointId: string, implementation: unknown): () => void {
  const token = `extension:${randomUUID()}`;
  providedImplementations.set(token, implementation as Record<string, unknown>);
  queueRegistration('extensions.register', {
    pointId,
    token,
    ...implementationShape(implementation),
  });
  return () => {
    providedImplementations.delete(token);
    void callHost('extensions.unregister', { token });
  };
}

const context = {
  manifest,
  logger: {
    info: (message: string) => {
      void callHost('logger.info', { message });
    },
    warn: (message: string) => {
      void callHost('logger.warn', { message });
    },
    error: (message: string) => {
      void callHost('logger.error', { message });
    },
  },
  media: {
    register: (input: unknown) => callHost('media.register', input),
    unregister: (input: unknown) => callHost('media.unregister', input),
    unregisterResource: (resourceType: string, resourceId: string) =>
      callHost('media.unregisterResource', { resourceType, resourceId }),
  },
  // 内核托管存储能力（ADR-0014 扩展）：worker 只拿到一个「远程序」provider 代理，
  // 字节/预签名/AWS 机制全部留在内核侧。控制面方法经 IPC 调用，参数与返回都不含字节。
  storage: {
    backend: async (spec: unknown) => {
      const handle = (await callHost('storage.backend', spec)) as {
        token: string;
        methods?: string[];
        values?: Record<string, unknown>;
      };
      const token = handle.token;
      const proxy: Record<string, unknown> = Object.assign(
        Object.create(null) as Record<string, unknown>,
        handle.values ?? {},
      );
      for (const method of handle.methods ?? []) {
        proxy[method] = (...args: unknown[]) => callHost('storage.invoke', { token, method, args });
      }
      return proxy;
    },
  },
  events: {
    publish: (topic: string, payload?: unknown) => {
      // publish must never block/kill a business handler (the state change
      // already happened), but a failed RPC must NOT be silent: report it to the
      // host logger and count it so a broken kernel link is observable.
      void callHost('events.publish', { topic, payload }).catch((error) => {
        publishFailures += 1;
        const message = error instanceof Error ? error.message : String(error);
        void callHost('logger.error', {
          message: `isolated events.publish failed for "${topic}" (total failures: ${publishFailures}): ${message.slice(0, 8192)}`,
        }).catch(() => undefined);
      });
    },
    subscribe: (
      topic: string,
      handler: (payload: unknown, meta?: { eventId?: string; topic?: string }) => void,
    ) => {
      const token = `event:${randomUUID()}`;
      subscriptions.set(token, handler);
      void callHost('events.subscribe', { topic, token }).catch(() => subscriptions.delete(token));
      return () => {
        subscriptions.delete(token);
        void callHost('events.unsubscribe', { token });
      };
    },
    intercept: () => {
      throw new Error('ctx.events.intercept 暂不支持跨进程同步协议');
    },
    waterfall: () => {
      throw new Error('ctx.events.waterfall 暂不支持跨进程同步协议');
    },
    runIdempotent: async (
      consumer: string,
      eventId: string,
      handler: () => void | Promise<void>,
    ) => {
      // Split the guard across the boundary: the host owns `processed_events`,
      // and the local handler only runs when the key was new.
      const shouldRun = (await callHost('events.runIdempotent', {
        consumer,
        eventId,
      })) as boolean;
      if (!shouldRun) return false;
      await handler();
      return true;
    },
  },
  jobs: {
    enqueue: (name: string, payload: unknown, options?: unknown) =>
      callHost('jobs.enqueue', { name, payload, options }),
    schedule: (name: string, schedule: unknown, payload?: unknown) =>
      callHost('jobs.schedule', { name, schedule, payload }),
    handle: (name: string, handler: (payload: unknown) => Promise<void> | void) => {
      const token = `job:${randomUUID()}`;
      jobs.set(token, handler);
      void callHost('jobs.handle', { name, token }).catch(() => jobs.delete(token));
      return () => {
        jobs.delete(token);
        void callHost('jobs.unhandle', { token });
      };
    },
  },
  state: {
    ...serviceProxy('state', [
      'get',
      'consume',
      'set',
      'del',
      'incr',
      'decr',
      'acquire',
      'release',
      'acquireLease',
      'renewLease',
      'releaseLease',
    ]),
    withLock: (key: string, ttlMs: number, fn: () => Promise<void>) => {
      const token = `state-lock:${randomUUID()}`;
      pendingStateLocks.set(token, fn);
      return callHost('state.withLock', { key, ttlMs, token }).finally(() =>
        pendingStateLocks.delete(token),
      );
    },
  },
  auth: serviceProxy('auth', [
    'verifyPassword',
    'registerUser',
    'ensureSystemUser',
    'issueSession',
    'revokeSession',
    'revokeAllSessions',
    'resetUserPassword',
    'sessionCookieConfig',
    'hasPermission',
    'listUserGroups',
    'listPermissionGroups',
    'grantUserGroup',
    'revokeUserGroup',
    'listUserGroupGrants',
    'pruneExpiredUserGroups',
    'getUser',
    'getUserByEmail',
    'listUsersByIds',
    'resolvePlatformToken',
    'inspectPlatformToken',
    'listPlatformTokens',
    'listAllPlatformTokens',
    'listPlatformTokensByScope',
    'createPlatformToken',
    'updatePlatformToken',
    'ownsPlatformToken',
    'deletePlatformToken',
    'audit',
    'listAuditLogs',
  ]),
  notifications: serviceProxy('notifications', [
    'create',
    'upsert',
    'listForUser',
    'unreadCount',
    'markRead',
    'markAllRead',
    'notifyPermissionHolders',
  ]),
  notificationPolicy: serviceProxy('notificationPolicy', [
    'listForUser',
    'updateForUser',
    'resetForUser',
    'listPolicy',
    'updatePolicy',
    'isEnabled',
    'enabledChannels',
    'inAppExclusions',
    'declares',
  ]),
  identity: serviceProxy('identity', [
    'requiresEmailVerification',
    'isDeliveryConfigured',
    'senderIds',
    'issue',
    'consume',
  ]),
  captcha: serviceProxy('captcha', [
    'mode',
    'isConfigured',
    'providerIds',
    'verify',
    'enforce',
    'clientConfig',
    'policyFor',
    'clientConfigFor',
  ]),
  secrets: serviceProxy('secrets', ['isAvailable', 'get', 'set', 'remove']),
  // 内核托管读缓存：把「查缓存 / 回源 / 回填」拆成三步 IPC。
  // 回源跑在插件进程（数据只能由插件自己的扩展读出来），但存储、边界与
  // 跨副本失效都在内核侧，插件只声明 kinds（ADR-0022 D3）。
  cache: {
    remember: async <T>(
      key: string,
      options: { ttlMs: number; kinds: readonly string[] },
      loader: () => Promise<T>,
    ): Promise<T> => {
      const cached = (await callHost('cache.peek', { key })) as { hit: boolean; value?: unknown };
      if (cached?.hit) return cached.value as T;
      const value = await loader();
      await callHost('cache.put', { key, value, ttlMs: options.ttlMs, kinds: [...options.kinds] });
      return value;
    },
    invalidate: async (kind: string) => {
      await callHost('cache.invalidate', { kinds: [kind] });
    },
  },

  payments: serviceProxy('payments', [
    'listPaymentMethods',
    // Provider capability map for the admin UI (which modes each provider
    // supports). Missing here means an isolated plugin sees an undefined method.
    'providerModes',
    'manualInstructions',
    'listAvailablePaymentMethods',
    'createRecord',
    'initiate',
    'create',
    'settle',
    'cancelExternalPayment',
    'cancelTopUp',
    'listTopUps',
    'getProviderConfig',
    'listByOrderIds',
    'manualInstructions',
    'listChannelMethods',
    'sweepExpired',
    'confirmManual',
    'cancelManual',
  ]),
  wallet: serviceProxy('wallet', [
    'getAccount',
    'hold',
    'settleHold',
    'releaseHold',
    'debit',
    'credit',
    'adjust',
    'listAccounts',
    'listLedger',
    'getMonthlySpending',
  ]),
  fx: serviceProxy('fx', [
    'quote',
    'quoteToSettlement',
    'getSettlementCurrency',
    'getRate',
    'listRates',
  ]),
  // Currency catalog. `list`/`listEnabled`/`get`/`requireEnabled` are async and
  // proxy over IPC; `toMinor`/`format` are synchronous in the kernel contract
  // (`CurrencyService`), so they run locally from SDK pure functions — a
  // round trip would force them to become async and break every plugin that
  // calls them inline. Missing this service made isolated plugins fail on
  // `ctx.currency.requireEnabled(...)` (referral's admin config route).
  currency: {
    ...serviceProxy('currency', ['list', 'listEnabled', 'get', 'requireEnabled']),
    toMinor: (value: number | string, code: string) => toMinorUnits(value, code),
    format: (amountMinor: number, code: string, locale: string) =>
      formatMinorCurrency(amountMinor, code, locale),
  },
  extensions,
  registerExtension,
  provide: provideService,
  getService: <T>(name: string) => serviceProxies.get(name) as T | undefined,
  requireService: <T>(name: string) => {
    const service = serviceProxies.get(name);
    if (!service) throw new Error(`服务 ${name} 不可用`);
    return service as T;
  },
  getExtensions: <T>(pointId: string) =>
    (extensionProxies.get(pointId) ?? []).map((entry) => entry.implementation as T),
  getExtensionsWithOwner: <T>(pointId: string) =>
    (extensionProxies.get(pointId) ?? []).map((entry) => ({
      pluginId: entry.pluginId,
      implementation: entry.implementation as T,
    })),
  tx: async (fn: (tx: unknown) => Promise<unknown>) => {
    const txId = String(await callHost('tx.begin', {}));
    const tx = {
      wallet: {
        debit: (...args: unknown[]) =>
          callHost('tx.wallet.debit', {
            txId,
            userId: args[0],
            amount: args[1],
            currency: args[2],
            ref: args[3],
          }),
        credit: (...args: unknown[]) =>
          callHost('tx.wallet.credit', {
            txId,
            userId: args[0],
            amount: args[1],
            currency: args[2],
            ref: args[3],
          }),
        hold: (...args: unknown[]) =>
          callHost('tx.wallet.hold', {
            txId,
            userId: args[0],
            amount: args[1],
            currency: args[2],
            ref: args[3],
            options: args[4],
          }),
        settleHold: (...args: unknown[]) =>
          callHost('tx.wallet.settleHold', {
            txId,
            holdId: args[0],
            settledAmount: args[1],
            ref: args[2],
          }),
        releaseHold: (...args: unknown[]) =>
          callHost('tx.wallet.releaseHold', { txId, holdId: args[0] }),
      },
      payments: {
        createRecord: (input: unknown) => callHost('tx.payments.createRecord', { txId, input }),
      },
      publish: (topic: string, payload?: unknown) => {
        // Buffered host-side and flushed with the same transaction (W1); a
        // failure here must surface, not be swallowed.
        void callHost('tx.events.publish', { txId, topic, payload }).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          void callHost('logger.error', {
            message: `isolated tx.publish failed for "${topic}": ${message.slice(0, 8192)}`,
          }).catch(() => undefined);
        });
      },
      extensions: {
        get: (model: unknown, name: string) =>
          callHost('tx.extensions.get', { txId, kind: modelKind(model), name }).then(
            reviveInstance,
          ),
        list: (model: unknown, query: unknown) =>
          callHost('tx.extensions.list', { txId, kind: modelKind(model), query }).then((result) => {
            const value = result as { items?: unknown[] };
            return { ...value, items: (value.items ?? []).map(reviveInstance) };
          }),
        listAll: (model: unknown, query?: unknown) =>
          callHost('tx.extensions.listAll', { txId, kind: modelKind(model), query }).then((items) =>
            (items as unknown[]).map(reviveInstance),
          ),
        create: (model: unknown, spec: unknown, options?: unknown) =>
          callHost('tx.extensions.create', {
            txId,
            kind: modelKind(model),
            spec: validateModelPayload(model, spec),
            options,
          }).then(reviveInstance),
        update: (model: unknown, name: string, spec: unknown, options?: unknown) =>
          callHost('tx.extensions.update', {
            txId,
            kind: modelKind(model),
            name,
            spec: validateModelPayload(model, spec),
            options,
          }).then(reviveInstance),
        updateWhere: (model: unknown, where: unknown, patch: unknown) =>
          callHost('tx.extensions.updateWhere', { txId, kind: modelKind(model), where, patch }),
        delete: (model: unknown, name: string) =>
          callHost('tx.extensions.delete', { txId, kind: modelKind(model), name }).then(
            () => undefined,
          ),
        registerFinalizer: () => {
          throw new Error('事务中不允许注册 finalizer');
        },
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

function serviceProxy(
  service: string,
  methods: string[],
): Record<string, (...args: unknown[]) => unknown> {
  return Object.fromEntries(
    methods.map((method) => [
      method,
      (...args: unknown[]) => {
        // Rebuilt predicates come first: they are the only way a declared-sync
        // method that takes arguments can stay synchronous across the bridge.
        const predicates = serviceSyncPredicates.get(service);
        if (predicates && Object.prototype.hasOwnProperty.call(predicates, method))
          return (predicates[method] as (...a: unknown[]) => unknown)(...args);
        const snapshot = serviceSyncValues.get(service);
        if (snapshot && Object.prototype.hasOwnProperty.call(snapshot, method))
          return snapshot[method];
        return callHost(`${service}.${method}`, args);
      },
    ]),
  ) as Record<string, (...args: unknown[]) => unknown>;
}

/* ------------------------------------------------------------------ *
 * Raw stream sessions (`kind: 'raw'` routes under isolated execution).
 * ------------------------------------------------------------------ */

interface RawSession {
  id: string;
  request: RawInvokeRequest;
  routePath: string;
  /** Request body stream handed to the plugin; created on demand. */
  body: HostRequestBody | null;
  status: number;
  headers: Array<[string, string | string[]]>;
  started: boolean;
  ended: boolean;
  aborted: boolean;
  /** Bytes queued but not yet handed to the IPC channel. */
  queue: Buffer[];
  queuedBytes: number;
  /** Resolvers waiting for the outbound queue to drain below the high-water mark. */
  drainWaiters: Array<() => void>;
  /** Bytes sent to the host but not yet acknowledged (response backpressure). */
  unackedBytes: number;
  pendingEnd: boolean;
  pullOutstanding: boolean;
  bodyDone: boolean;
  clientCloseListeners: Array<() => void>;
}

const rawSessions = new Map<string, RawSession>();

/** Request-body Readable that pulls chunks from the host on demand. */
class HostRequestBody extends Readable {
  private readonly session: RawSession;

  constructor(session: RawSession) {
    super({ highWaterMark: RAW_CHUNK_BYTES });
    this.session = session;
  }

  override _read(): void {
    const session = this.session;
    if (session.bodyDone || session.aborted || session.pullOutstanding) return;
    session.pullOutstanding = true;
    sendHost({ protocol: RPC_PROTOCOL, pluginId, type: 'raw-pull', id: session.id });
  }

  deliver(data: Buffer): void {
    this.session.pullOutstanding = false;
    this.push(data);
  }

  finish(): void {
    this.session.bodyDone = true;
    this.session.pullOutstanding = false;
    this.push(null);
  }

  fail(message: string): void {
    this.session.bodyDone = true;
    this.session.pullOutstanding = false;
    // `destroy(error)` emits 'error'. With no listener that is an *unhandled*
    // 'error' event, which tears down the whole worker process — one client
    // disconnecting mid-request would quarantine the plugin for every tenant.
    // A close/abort before the handler starts reading is normal, so guarantee a
    // listener exists. A handler already reading still sees the failure: its own
    // `for await` / `once('error')` registers an additional listener.
    if (this.listenerCount('error') === 0) this.on('error', () => undefined);
    this.destroy(Object.assign(new Error(message), { code: 'raw.body' }));
  }
}

function rawSessionOf(id: string): RawSession | undefined {
  return rawSessions.get(id);
}

function sendRawHead(session: RawSession): void {
  if (session.started) return;
  session.started = true;
  sendHost({
    protocol: RPC_PROTOCOL,
    pluginId,
    type: 'raw-head',
    id: session.id,
    status: session.status,
    headers: session.headers,
  });
}

/**
 * Drain the outbound queue while the ack window allows, flushing the head before
 * the first chunk and ending once the queue empties (`pendingEnd`).
 */
function flushRaw(session: RawSession): void {
  if (session.ended || session.aborted) return;
  while (session.queue.length > 0 && session.unackedBytes < RAW_WINDOW_BYTES) {
    sendRawHead(session);
    const chunk = session.queue.shift() as Buffer;
    session.queuedBytes -= chunk.length;
    session.unackedBytes += chunk.length;
    sendHost({
      protocol: RPC_PROTOCOL,
      pluginId,
      type: 'raw-chunk',
      id: session.id,
      data: chunk.toString('base64'),
    });
  }
  if (session.queue.length === 0 && session.pendingEnd) {
    sendRawHead(session);
    session.ended = true;
    sendHost({ protocol: RPC_PROTOCOL, pluginId, type: 'raw-end', id: session.id });
    rawSessions.delete(session.id);
  }
  // Wake anyone parked in `drain()` once the ack window has room again. The
  // condition must match what `write()` reports as backpressure, which counts
  // both queued and still-unacknowledged bytes.
  if (rawWritable(session) && session.drainWaiters.length > 0) {
    const waiters = session.drainWaiters.splice(0, session.drainWaiters.length);
    for (const resolve of waiters) resolve();
  }
}

/** True when the stream can accept another window's worth of bytes. */
function rawWritable(session: RawSession): boolean {
  return session.unackedBytes + session.queuedBytes < RAW_WINDOW_BYTES;
}

/**
 * Await capacity in the outbound queue. Resolves immediately when the stream
 * has already ended/aborted or the ack window has room, so callers can
 * `await drain()` unconditionally without stalling a healthy connection.
 * While blocked, the returned promise only settles when `flushRaw` observes an
 * ack freeing window space, or the stream aborts — so it must not resolve on a
 * mere empty queue, or a plugin would keep writing past the window.
 */
function drainRaw(session: RawSession): Promise<void> {
  if (session.ended || session.aborted) return Promise.resolve();
  if (rawWritable(session)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    session.drainWaiters.push(resolve);
  });
}

/** Split an outbound write into IPC-sized chunks and enqueue them. */
function enqueueRaw(session: RawSession, data: Buffer): void {
  let offset = 0;
  while (offset < data.length) {
    const chunk = data.subarray(offset, offset + RAW_CHUNK_BYTES);
    offset += chunk.length;
    // Copy out of the caller's buffer: a plugin may reuse it after `write`.
    const owned = Buffer.from(chunk);
    session.queue.push(owned);
    session.queuedBytes += owned.length;
  }
  // Hard ceiling: `flushRaw` only runs while the ack window allows, so a slow
  // client would otherwise let the queue grow without bound (ADR-0022 P1). The
  // plugin is expected to honour `write()`/`drain()`; if a misbehaving handler
  // ignores backpressure we must still bound worker memory, so fail the stream
  // instead of growing until the container OOMs.
  if (session.queuedBytes > RAW_MAX_QUEUE_BYTES) {
    sendHost({
      protocol: RPC_PROTOCOL,
      pluginId,
      type: 'raw-error',
      id: session.id,
      error: { message: 'isolated plugin raw stream queue limit exceeded' },
    });
    abortRawSession(session.id, 'raw stream queue limit exceeded');
  }
}

/** `RawHttpReply` view forwarded to the host over stream frames. */
function rawReplyView(session: RawSession): Record<string, unknown> {
  const setHeader = (name: string, value: string | string[]): void => {
    if (!session.started) session.headers.push([name, value]);
  };
  const view: Record<string, unknown> = {
    status: (code: number) => {
      if (!session.started) session.status = code;
      return view;
    },
    header: (name: string, value: string | string[]) => {
      setHeader(name, value);
      return view;
    },
    write: (chunk: string | Uint8Array) => {
      if (session.ended || session.aborted) return false;
      enqueueRaw(session, typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
      flushRaw(session);
      return session.unackedBytes + session.queuedBytes < RAW_WINDOW_BYTES;
    },
    drain: () => drainRaw(session),
    end: (body?: string | Uint8Array) => {
      if (session.ended || session.aborted) return;
      if (body !== undefined)
        enqueueRaw(session, typeof body === 'string' ? Buffer.from(body) : Buffer.from(body));
      session.pendingEnd = true;
      flushRaw(session);
    },
    hijack: () => undefined,
    onClientClose: (fn: () => void) => {
      if (session.aborted) {
        try {
          fn();
        } catch {
          /* handler-owned */
        }
        return;
      }
      session.clientCloseListeners.push(fn);
    },
    raw: {
      get headersSent() {
        return session.started;
      },
      setHeader,
    },
  };
  return view;
}

/**
 * Run a raw route against streamed views. Returns once the handler resolves or
 * throws; the reply frames are flushed as the handler writes.
 */
async function runRawRoute(session: RawSession): Promise<void> {
  const route = definition.routes?.find(
    (candidate) =>
      candidate.method === session.request.method && candidate.path === session.routePath,
  );
  if (!route || route.kind !== 'raw') {
    sendHost({
      protocol: RPC_PROTOCOL,
      pluginId,
      type: 'raw-error',
      id: session.id,
      error: { message: 'isolated raw route not found' },
    });
    rawSessions.delete(session.id);
    return;
  }
  const body = new HostRequestBody(session);
  session.body = body;
  const requestView = {
    method: session.request.method,
    url: session.request.url,
    params: session.request.params,
    query: new URLSearchParams(session.request.query),
    headers: session.request.headers,
    body,
    ip: session.request.ip,
    ...(session.request.user ? { user: session.request.user } : {}),
    ...(session.request.sessionToken ? { sessionToken: session.request.sessionToken } : {}),
    raw: { headers: session.request.headers },
  };
  const replyView = rawReplyView(session);
  try {
    await (route.handler as RouteHook)(requestView, replyView);
    if (!session.ended && !session.aborted) {
      session.pendingEnd = true;
      flushRaw(session);
    }
  } catch (error) {
    if (session.aborted) return;
    session.ended = true;
    rawSessions.delete(session.id);
    // Mirror the in-process path: before headers, the dispatcher maps this to a
    // problem+json response; after headers, it destroys the partial response.
    sendHost({
      protocol: RPC_PROTOCOL,
      pluginId,
      type: 'raw-error',
      id: session.id,
      error: wireThrown(error),
    });
  }
}

/** Abort a raw session because the client disconnected (fires `onClientClose`). */
function abortRawSession(id: string, reason: string): void {
  const session = rawSessions.get(id);
  if (!session) return;
  session.aborted = true;
  rawSessions.delete(id);
  session.body?.fail(reason);
  // Unblock any handler parked in `drain()`; the stream is gone.
  const waiters = session.drainWaiters.splice(0, session.drainWaiters.length);
  for (const resolve of waiters) resolve();
  for (const fn of session.clientCloseListeners) {
    try {
      fn();
    } catch {
      /* handler-owned */
    }
  }
  session.clientCloseListeners.length = 0;
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
    meta?: { eventId?: string; topic?: string; createdAt?: unknown };
    error?: { message: string };
    value?: unknown;
  };
  if (message?.protocol !== RPC_PROTOCOL || message.pluginId !== pluginId) return;
  // `event` and `sync-services` are unsolicited pushes and carry no request id.
  if (!message.id && message.type !== 'event' && message.type !== 'sync-services') return;
  const requestId = message.id as string;
  if (message.type === 'result') {
    const waiter = pending.get(requestId);
    if (!waiter) return;
    pending.delete(requestId);
    clearTimeout(waiter.timer);
    if (message.error) {
      // Shared revival: restores `code`/`status`/`details` and the SDK
      // error-class brand. A plain `Object.assign` copied the fields but lost
      // the brand, so `isWalletError(e)` inside the plugin returned false and
      // error-specific branches (e.g. insufficient-balance) never ran.
      waiter.reject(reviveWireError(message.error));
    } else waiter.resolve(message.value);
    return;
  }
  // Host-pushed synchronous service values. Sent after activation and again
  // whenever a snapshot input changes at runtime (a captcha mode, the session
  // cookie config), so the plain values `ctx.*` returns stay current instead of
  // being frozen at activation time. See `service-contract.ts` in the host.
  if (message.type === 'sync-services') {
    const frame = message as {
      syncValues?: Record<string, Record<string, unknown>>;
      syncPredicates?: Record<string, Record<string, unknown>>;
    };
    for (const [name, values] of Object.entries(frame.syncValues ?? {})) {
      serviceSyncValues.set(name, values);
    }
    for (const [name, values] of Object.entries(frame.syncPredicates ?? {})) {
      const built = buildSyncPredicates(values);
      if (built) serviceSyncPredicates.set(name, built);
    }
    return;
  }
  if (message.type === 'cancel') {
    serviceControllers.get(requestId)?.abort();
    const waiter = pending.get(requestId);
    if (waiter) {
      clearTimeout(waiter.timer);
      pending.delete(requestId);
      waiter.reject(new Error('RPC request cancelled'));
    }
    return;
  }
  if (message.type === 'event') {
    const listener = subscriptions.get(message.token ?? '');
    if (listener) {
      try {
        listener(message.payload, message.meta);
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
    } catch (error) {
      sendHost({
        protocol: RPC_PROTOCOL,
        pluginId,
        type: 'result',
        id: requestId,
        error: wireError(error),
      });
    }
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
      sendHost({
        protocol: RPC_PROTOCOL,
        pluginId,
        type: 'result',
        id: requestId,
        error: wireError(error),
      });
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
      sendHost({
        protocol: RPC_PROTOCOL,
        pluginId,
        type: 'result',
        id: requestId,
        error: wireError(error),
      });
    }
    return;
  }
  if (message.type === 'service') {
    const controller = new AbortController();
    serviceControllers.set(requestId, controller);
    try {
      const implementation = providedImplementations.get(message.token ?? '');
      const method = implementation?.[String(message.method ?? '')];
      if (typeof method !== 'function')
        throw new Error('isolated service method is not registered');
      const args = Array.isArray(message.payload) ? message.payload : [];
      if (args[1] && typeof args[1] === 'object' && 'callId' in args[1])
        args[1] = { ...args[1], signal: controller.signal };
      // 必须带上 receiver：实现可能是类的实例，方法内部会访问 this（如
      // provider 的 private 辅助方法）。直接 `method(...args)` 会把 this 丢成
      // undefined，表现为「Cannot read properties of undefined (reading 'x')」，
      // 而对象字面量风格的实现看不出任何异常。
      const result = await method.apply(implementation, args);
      sendHost({ protocol: 1, pluginId, type: 'result', id: requestId, value: result });
    } catch (error) {
      sendHost({
        protocol: RPC_PROTOCOL,
        pluginId,
        type: 'result',
        id: requestId,
        error: wireError(error),
      });
    } finally {
      serviceControllers.delete(requestId);
    }
    return;
  }
  if (message.type === 'lifecycle') {
    try {
      const lifecycleContext = message.context as
        | {
            services?: Array<{
              name: string;
              methods: string[];
              values?: Record<string, unknown>;
              syncValues?: Record<string, unknown>;
            }>;
            /** Plain values for SDK-declared synchronous kernel service methods. */
            syncValues?: Record<string, Record<string, unknown>>;
            /** Shipped inputs for SDK-declared synchronous *predicates*. */
            syncPredicates?: Record<string, Record<string, unknown>>;
            extensions?: Array<{
              pointId: string;
              ownerId: string;
              index: number;
              methods: string[];
              values?: Record<string, unknown>;
            }>;
          }
        | undefined;
      const bindings = lifecycleContext?.services ?? [];
      for (const binding of bindings) {
        const proxy: Record<string, unknown> = Object.assign(
          Object.create(null) as Record<string, unknown>,
          binding.values ?? {},
        );
        for (const method of binding.methods) {
          proxy[method] = (...args: unknown[]) =>
            callHost('services.invoke', { name: binding.name, method, args });
        }
        serviceProxies.set(binding.name, proxy);
        serviceSyncValues.set(binding.name, binding.syncValues ?? {});
      }
      // Kernel capability services (`ctx.payments`, `ctx.secrets`, …) are not
      // bindings: they reach the worker through the capability channel, and their
      // SDK-declared synchronous methods arrive here as plain values. Without this
      // the calls fell through to `callHost` and returned a promise — a truthy
      // promise, so `if (!ctx.secrets.isAvailable())` could never take the
      // negative branch. See service-contract.ts.
      for (const [name, values] of Object.entries(lifecycleContext?.syncValues ?? {})) {
        serviceSyncValues.set(name, values);
      }
      for (const [name, values] of Object.entries(lifecycleContext?.syncPredicates ?? {})) {
        const built = buildSyncPredicates(values);
        if (built) serviceSyncPredicates.set(name, built);
      }
      extensionProxies.clear();
      for (const binding of lifecycleContext?.extensions ?? []) {
        const proxy: Record<string, unknown> = Object.assign(
          Object.create(null) as Record<string, unknown>,
          binding.values ?? {},
        );
        for (const method of binding.methods) {
          proxy[method] = (...args: unknown[]) =>
            callHost('extensions.invoke', {
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
      const hook =
        message.phase === 'register'
          ? definition.onRegister
          : message.phase === 'activate'
            ? definition.onActivate
            : definition.onDeactivate;
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
        providedImplementations.clear();
        serviceProxies.clear();
        serviceSyncValues.clear();
        extensionProxies.clear();
      }
      sendHost({ protocol: 1, pluginId, type: 'result', id: requestId, value: undefined });
    } catch (error) {
      sendHost({
        protocol: RPC_PROTOCOL,
        pluginId,
        type: 'result',
        id: requestId,
        error: wireError(error),
      });
    }
    return;
  }
  if (message.type === 'raw-body') {
    const session = rawSessionOf(requestId);
    const body = session?.body;
    if (session && body && !session.aborted) {
      const frame = message as unknown as { data?: string; eof?: boolean };
      if (frame.eof || frame.data === undefined) body.finish();
      else body.deliver(Buffer.from(frame.data, 'base64'));
    }
    return;
  }
  if (message.type === 'raw-body-error') {
    const session = rawSessionOf(requestId);
    if (session && session.body && !session.aborted) {
      session.body.fail(
        String((message as unknown as { message?: unknown }).message ?? 'raw body error'),
      );
    }
    return;
  }
  if (message.type === 'raw-abort') {
    abortRawSession(
      requestId,
      String((message as unknown as { reason?: unknown }).reason ?? 'client disconnected'),
    );
    return;
  }
  if (message.type === 'raw-ack') {
    const session = rawSessionOf(requestId);
    if (session) {
      const bytes = Number((message as unknown as { bytes?: unknown }).bytes ?? 0);
      session.unackedBytes = Math.max(0, session.unackedBytes - bytes);
      flushRaw(session);
    }
    return;
  }
  if (message.type === 'raw-invoke') {
    const frame = message as unknown as { request: RawInvokeRequest; route?: string };
    if (rawSessions.size >= RPC_MAX_RAW_STREAMS) {
      sendHost({
        protocol: RPC_PROTOCOL,
        pluginId,
        type: 'raw-error',
        id: requestId,
        error: { message: 'isolated plugin raw stream limit exceeded' },
      });
      return;
    }
    const session: RawSession = {
      id: requestId,
      request: frame.request,
      routePath: String(frame.route ?? ''),
      body: null,
      status: 200,
      headers: [],
      started: false,
      ended: false,
      aborted: false,
      queue: [],
      queuedBytes: 0,
      drainWaiters: [],
      unackedBytes: 0,
      pendingEnd: false,
      pullOutstanding: false,
      bodyDone: false,
      clientCloseListeners: [],
    };
    rawSessions.set(requestId, session);
    void runRawRoute(session);
    return;
  }
  if (message.type !== 'invoke') return;
  const route = definition.routes?.find(
    (candidate) => candidate.method === message.method && candidate.path === message.route,
  );
  if (!route) {
    sendHost({
      protocol: 1,
      pluginId,
      type: 'result',
      id: requestId,
      error: { message: 'isolated route not found' },
    });
    return;
  }
  try {
    let status: number | undefined;
    let sent = false;
    let payload: unknown;
    let headers: Array<[string, string]> = [];
    // `HttpReply.code` is chainable per the SDK contract: plugins write
    // `reply.code(201).send(body)`. Returning `undefined` here made that chain
    // throw "Cannot read properties of undefined (reading 'send')", which killed
    // the whole worker on the first handler-route request (ADR-0022 P0).
    const replyView: Record<string, unknown> = {
      code: (next: number) => {
        status = next;
        return replyView;
      },
      // Response headers are collected here because the worker only sends the
      // status and payload back. Dropping them silently would break any route
      // that serves something other than JSON (a script needs its own MIME).
      header: (name: string, value: string) => {
        headers = [
          ...headers.filter(([existing]) => existing.toLowerCase() !== name.toLowerCase()),
          [name, value],
        ];
        return replyView;
      },
      send: (next: unknown) => {
        sent = true;
        payload = next;
      },
    };
    const value = await route.handler(message.request as never, replyView as never);
    sendHost({
      protocol: 1,
      pluginId,
      type: 'result',
      id: requestId,
      value: sent ? undefined : value,
      ...(sent || status !== undefined
        ? {
            response: {
              ...(status !== undefined ? { status } : {}),
              ...(headers.length > 0 ? { headers } : {}),
              ...(sent ? { payload } : {}),
            },
          }
        : {}),
    });
  } catch (error) {
    // Route `wireError` (not a hand-rolled literal) so `details` and the SDK
    // error-class brand survive the boundary. Dropping the brand broke
    // `isWalletError`/`isPluginError` narrowing on the host.
    sendHost({
      protocol: 1,
      pluginId,
      type: 'result',
      id: requestId,
      error: wireError(error),
    });
  }
});
