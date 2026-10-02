/**
 * Capability Registry（PLAN-open-platform P1 / ADR-0012 周边）。
 *
 * 对外开放面只做「传输适配」：每个可开放操作在此声明为一条能力项，`/api/v1`
 * 的文档与发现接口都从它派生，避免「内部特权通道」与「第三方通道」两套实现
 * 漂移（ADR-0001 硬原则）。
 *
 * 能力项有两个来源：
 *   1. 内核自有操作（本文件的 {@link CAPABILITIES}），路由由 `open-api-v1` 直接服务；
 *   2. 插件操作（`manifest.capabilities`），由 {@link PluginRuntime} 实例持有并改写为
 *      `/api/v1` 别名，分发到插件同一个 handler、同一套 guard（见 `plugins/runtime.ts`）。
 *      插件能力挂在运行时实例上而非模块级，避免同一进程内多个 app 实例互相污染。
 *
 * scope 策略（P1 先粗后细）：直接复用现有权限键——`null` 表示仅身份（如「读我自己
 * 的钱包」，本人即授权），其余填内核权限键（如 `platform.admin`）。token 的有效权限
 * 始终是「token.scopes ∩ 主人当前权限」，因此用标准 `requirePermission(scope)` 即可
 * 完成鉴权，无需另造一套。
 */
import type { HttpMethod } from '@stackpanel/sdk';

/** The open API version surfaced under `/api/v1`. */
export const OPEN_API_VERSION = 'v1';

/** One externally-callable operation. */
export interface Capability {
  /** Stable, namespaced id, e.g. `wallet.balance.read`. */
  id: string;
  method: HttpMethod;
  /** Concrete path (already versioned). */
  path: string;
  /**
   * Required scope; `null` = identity-only (caller authorizes self). Since P1
   * slice four this may be a refined `资源:read|write` key (e.g. `user:write`)
   * in addition to a coarse permission key (`资源.admin`).
   */
  scope: string | null;
  /** Neutral English summary for the public OpenAPI doc. */
  summary: string;
  /** Whether the operation changes state (writes need `Idempotency-Key`). */
  mutating: boolean;
  /** Owning plugin id for plugin-contributed capabilities; absent for kernel ones. */
  pluginId?: string;
}

/**
 * Refined `资源:read|write` resource → the coarse permission keys whose holders
 * may grant that resource's refined scopes (P1 slice four).
 *
 * Scope refinement must not widen access: a refined sub-scope grants strictly
 * less than the coarse permission it is derived from, and the coarse permission
 * remains the holder's admission gate. This table is the single place that
 * says which coarse key governs which resource, so issuance
 * ({@link canGrantScope}) and enforcement ({@link scopeSatisfied}) cannot drift.
 */
export const RESOURCE_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  user: ['platform.admin', 'platform.manage.users'],
  gateway: ['llm-gateway.use', 'llm-gateway.admin'],
};

/** The `资源` part of a refined `资源:read|write` scope, if it is one. */
export function scopeResource(scope: string): string | null {
  const index = scope.indexOf(':');
  if (index <= 0) return null;
  return scope.slice(0, index);
}

/**
 * Whether `permissions` (an effective permission set) satisfies `scope`.
 *
 * A `null` scope is identity-only. A refined `资源:read|write` scope is
 * satisfied by the exact key, by a coarse permission governing the resource
 * (e.g. `gateway` ← `llm-gateway.use`), or by a `资源:admin` super-key.
 * Non-refined scopes must match exactly, preserving slice-one/two/three
 * semantics.
 */
export function scopeSatisfied(
  scope: string | null,
  permissions: ReadonlySet<string> | readonly string[],
): boolean {
  if (scope === null) return true;
  const owned = permissions instanceof Set ? permissions : new Set(permissions);
  if (owned.has(scope)) return true;
  const resource = scopeResource(scope);
  if (!resource) return false;
  if (owned.has(`${resource}:admin`)) return true;
  return (RESOURCE_PERMISSIONS[resource] ?? []).some((permission) => owned.has(permission));
}

/** Whether a caller holding `owned` may hand `scope` to a token (no privilege escalation). */
export function canGrantScope(
  scope: string,
  owned: ReadonlySet<string> | readonly string[],
): boolean {
  return scopeSatisfied(scope, owned);
}

/**
 * Every scope a caller holding `owned` may grant: the coarse permission keys
 * they hold, plus the refined `资源:read|write` scopes for resources their
 * coarse permissions govern (and `资源:admin` when they hold it directly).
 */
export function grantableScopesFor(owned: ReadonlySet<string> | readonly string[]): string[] {
  const set = owned instanceof Set ? owned : new Set(owned);
  const out = new Set<string>(set);
  for (const [resource, coarse] of Object.entries(RESOURCE_PERMISSIONS)) {
    if (coarse.some((permission) => set.has(permission)) || set.has(`${resource}:admin`)) {
      out.add(`${resource}:read`);
      out.add(`${resource}:write`);
    }
  }
  return [...out].sort();
}

/**
 * The authoritative list of kernel-owned open capabilities. Keep it small and
 * honest: only operations actually served under `/api/v1` belong here.
 */
export const CAPABILITIES: readonly Capability[] = [
  {
    id: 'platform.info.read',
    method: 'GET',
    path: '/api/v1/platform',
    scope: null,
    summary: 'Public platform identity',
    mutating: false,
  },
  {
    id: 'platform.info.write',
    method: 'PATCH',
    path: '/api/v1/platform',
    scope: 'platform.admin',
    summary: 'Update the platform identity (requires platform.admin)',
    mutating: true,
  },
  {
    id: 'identity.read',
    method: 'GET',
    path: '/api/v1/me',
    scope: null,
    summary: 'The caller identity behind the presented credential',
    mutating: false,
  },
  {
    id: 'capability.list',
    method: 'GET',
    path: '/api/v1/capabilities',
    scope: null,
    summary: 'Capabilities this credential is allowed to call',
    mutating: false,
  },
  {
    id: 'wallet.balance.read',
    method: 'GET',
    path: '/api/v1/wallet/balance',
    scope: null,
    summary: "The caller's own wallet balance",
    mutating: false,
  },
  {
    id: 'wallet.ledger.read',
    method: 'GET',
    path: '/api/v1/wallet/ledger',
    scope: null,
    summary: "The caller's own wallet ledger entries",
    mutating: false,
  },
  {
    id: 'wallet.accounts.read',
    method: 'GET',
    path: '/api/v1/wallet/accounts',
    scope: 'platform.admin',
    summary: 'Wallet accounts across the platform (requires platform.admin)',
    mutating: false,
  },
  {
    id: 'user.list',
    method: 'GET',
    path: '/api/v1/users',
    scope: 'user:read',
    summary: 'List users (requires the user:read scope)',
    mutating: false,
  },
  {
    id: 'user.read',
    method: 'GET',
    path: '/api/v1/users/:id',
    scope: 'user:read',
    summary: 'Read one user with wallet, services, orders and ledger',
    mutating: false,
  },
  {
    id: 'user.create',
    method: 'POST',
    path: '/api/v1/users',
    scope: 'user:write',
    summary: 'Create a user (requires the user:write scope)',
    mutating: true,
  },
  {
    id: 'user.update',
    method: 'PATCH',
    path: '/api/v1/users/:id',
    scope: 'user:write',
    summary: 'Update a user status or group memberships',
    mutating: true,
  },
  {
    id: 'user.password.reset',
    method: 'POST',
    path: '/api/v1/users/:id/reset-password',
    scope: 'user:write',
    summary: 'Reset a user password and revoke their sessions',
    mutating: true,
  },
  {
    id: 'user.wallet.adjust',
    method: 'POST',
    path: '/api/v1/users/:id/wallet',
    scope: 'user:write',
    summary: 'Adjust a user wallet balance',
    mutating: true,
  },
  {
    id: 'user.service.gift',
    method: 'POST',
    path: '/api/v1/users/:id/services',
    scope: 'user:write',
    summary: 'Gift a service instance to a user',
    mutating: true,
  },
];

/** A capability contributed by an active plugin. */
export interface PluginCapabilityEntry extends Capability {
  pluginId: string;
}

/**
 * Capabilities callable by a caller.
 *
 * `permissions` is the caller's effective (coarse) permission set; `refinedScopes`
 * optionally adds the refined `资源:read|write` scopes a token carries, so
 * discovery matches enforcement (a read-only token sees the read capabilities,
 * not the write ones).
 */
export function capabilitiesFor(
  permissions: ReadonlySet<string> | readonly string[],
  pluginCapabilities: readonly Capability[] = [],
  refinedScopes: readonly string[] = [],
): Capability[] {
  const owned = permissions instanceof Set ? permissions : new Set(permissions);
  return [...CAPABILITIES, ...pluginCapabilities].filter((cap) => {
    if (scopeSatisfied(cap.scope, owned)) return true;
    if (cap.scope === null) return true;
    return refinedScopes.includes(cap.scope);
  });
}

/** Match `method` + `pathname` against the declared capabilities (best effort). */
export function matchCapability(
  method: string,
  pathname: string,
  pluginCapabilities: readonly Capability[] = [],
): Capability | undefined {
  return [...CAPABILITIES, ...pluginCapabilities].find(
    (cap) => cap.method === method && pathMatches(cap.path, pathname),
  );
}

/** Path template match: literal segments equal, `:param` captures anything. */
function pathMatches(template: string, pathname: string): boolean {
  const a = template.split('/').filter(Boolean);
  const b = pathname.split('/').filter(Boolean);
  if (a.length !== b.length) return false;
  return a.every((segment, i) => segment.startsWith(':') || segment === b[i]);
}
