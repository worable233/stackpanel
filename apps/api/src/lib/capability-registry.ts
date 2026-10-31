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
  /** 缺省写操作视为危险；false 仅用于明确可逆的写。 */
  destructive?: boolean;
  /** Owning plugin id for plugin-contributed capabilities; absent for kernel ones. */
  pluginId?: string;
}

/**
 * Refined `资源:read|write` resource → the coarse permission keys whose holders
 * may grant that resource's refined scopes (P1 slice four).
 *
 * Scope refinement must not widen access: a refined sub-scope grants strictly
 * less than the coarse permission it is derived from, and the coarse permission
 * remains the holder's admission gate.
 *
 * ADR-0021 §D1: the kernel no longer hardcodes *plugin* permission keys. This
 * table is the **kernel-owned resource baseline** only. A plugin declares which
 * resources its permissions govern via `PluginPermission.scope`; the runtime
 * aggregates those at {@link PluginRuntime.scopeGovernance} and the consumers
 * pass the merged table in. The kernel therefore stays ignorant of any concrete
 * business plugin's permission namespace.
 */
export type ScopeGovernance = Readonly<Record<string, readonly string[]>>;

/** Resources the kernel itself owns (identity/RBAC/settings/...). Always in scope. */
export const KERNEL_RESOURCE_PERMISSIONS: ScopeGovernance = {
  user: ['platform.admin', 'platform.manage.users'],
  settings: ['platform.admin', 'platform.manage.settings'],
  plugins: ['platform.admin', 'platform.manage.plugins'],
  rbac: ['platform.admin', 'platform.manage.permissions'],
  // No dedicated `platform.manage.*` key yet: these resources are admin-only by
  // design, so `platform.admin` alone governs them. Listing the resource (with
  // an empty rider set is NOT enough — the scope still needs a coarse key to
  // pass `scopeSatisfied`) keeps the refined scope meaningful rather than
  // accidentally admissible to every admin-only token.
  audit: ['platform.admin'],
  jobs: ['platform.admin'],
  secret: ['platform.admin'],
  signing: ['platform.admin'],
  distribution: ['platform.admin'],
  update: ['platform.admin'],
  payment: ['platform.admin'],
  sales: ['platform.admin'],
  notification: ['platform.admin'],
  currency: ['platform.admin'],
  theme: ['platform.admin'],
  agent: ['platform.admin'],
};

/**
 * @deprecated Kernel baseline only (ADR-0021). Prefer passing an explicit
 * runtime-aggregated {@link ScopeGovernance}; retained for the tests and any
 * call site that has no runtime at hand (fail-closed: fewer grants).
 */
export const RESOURCE_PERMISSIONS = KERNEL_RESOURCE_PERMISSIONS;

/**
 * Merge governance tables left-to-right; later tables add keys to a resource
 * without dropping earlier ones. Undefined entries are ignored, so callers can
 * pass an optional runtime table and still get the kernel baseline.
 */
export function mergeScopeGovernance(
  ...tables: Array<ScopeGovernance | undefined>
): ScopeGovernance {
  const out = new Map<string, Set<string>>();
  for (const table of tables) {
    if (!table) continue;
    for (const [resource, keys] of Object.entries(table)) {
      const set = out.get(resource) ?? new Set<string>();
      for (const key of keys) set.add(key);
      out.set(resource, set);
    }
  }
  const merged: Record<string, readonly string[]> = {};
  for (const [resource, keys] of out) merged[resource] = [...keys];
  return merged;
}

/** A plugin's declared permissions, in the mixed manifest form. */
type DeclaredPermissions = ReadonlyArray<
  string | { readonly key: string; readonly scope?: string }
>;

/**
 * Aggregate the refined-scope governance table from plugin manifests (ADR-0021
 * §D1). Each `permission.scope` says "holding this permission governs this
 * refined-scope resource"; the result merges them on top of the kernel baseline.
 *
 * Pure and dependency-free so it can be unit-tested and reused by
 * {@link PluginRuntime.scopeGovernance}.
 */
export function aggregateScopeGovernance(
  pluginPermissions: readonly DeclaredPermissions[],
): ScopeGovernance {
  const tables: Array<Record<string, string[]>> = [];
  for (const permissions of pluginPermissions) {
    const table: Record<string, string[]> = {};
    for (const permission of permissions) {
      if (typeof permission === 'string' || !permission.scope) continue;
      (table[permission.scope] ??= []).push(permission.key);
    }
    if (Object.keys(table).length > 0) tables.push(table);
  }
  return mergeScopeGovernance(KERNEL_RESOURCE_PERMISSIONS, ...tables);
}

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
 * (per `governance`), or by a `资源:admin` super-key. Non-refined scopes must
 * match exactly, preserving slice-one/two/three semantics. Without an explicit
 * governance table only the kernel baseline applies (fail-closed).
 */
export function scopeSatisfied(
  scope: string | null,
  permissions: ReadonlySet<string> | readonly string[],
  governance: ScopeGovernance = KERNEL_RESOURCE_PERMISSIONS,
): boolean {
  if (scope === null) return true;
  const owned = permissions instanceof Set ? permissions : new Set(permissions);
  if (owned.has(scope)) return true;
  const resource = scopeResource(scope);
  if (!resource) return false;
  if (owned.has(`${resource}:admin`)) return true;
  return (governance[resource] ?? []).some((permission) => owned.has(permission));
}

/** Whether a caller holding `owned` may hand `scope` to a token (no privilege escalation). */
export function canGrantScope(
  scope: string,
  owned: ReadonlySet<string> | readonly string[],
  governance: ScopeGovernance = KERNEL_RESOURCE_PERMISSIONS,
): boolean {
  return scopeSatisfied(scope, owned, governance);
}

/**
 * Every scope a caller holding `owned` may grant: the coarse permission keys
 * they hold, plus the refined `资源:read|write` scopes for resources their
 * coarse permissions govern (and `资源:admin` when they hold it directly).
 */
export function grantableScopesFor(
  owned: ReadonlySet<string> | readonly string[],
  governance: ScopeGovernance = KERNEL_RESOURCE_PERMISSIONS,
): string[] {
  const set = owned instanceof Set ? owned : new Set(owned);
  const out = new Set<string>(set);
  for (const [resource, coarse] of Object.entries(governance)) {
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
  { id: 'theme.configuration.read', method: 'GET', path: '/api/v1/themes/:id/configuration', scope: 'platform.admin', summary: 'Read theme configuration, schema, defaults, version and last 20 snapshots', mutating: false },
  { id: 'theme.configuration.validate', method: 'POST', path: '/api/v1/themes/:id/configuration/validate', scope: 'platform.admin', summary: 'Validate a partial theme settings JSON without saving; body: {settings}', mutating: false },
  { id: 'theme.configuration.write', method: 'PATCH', path: '/api/v1/themes/:id/configuration', scope: 'platform.admin', summary: 'Update theme settings; body: {settings, expectedVersion}. Read configuration first. To roll back submit snapshot settings with current expectedVersion.', mutating: true, destructive: false },

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
    scope: 'platform.admin',
    summary: 'Adjust a user wallet balance (requires platform.admin)',
    mutating: true,
  },
  {
    id: 'user.service.gift',
    method: 'POST',
    path: '/api/v1/users/:id/services',
    scope: 'platform.admin',
    summary: 'Gift a service instance to a user (requires platform.admin)',
    mutating: true,
  },
  // Kernel Agent (PLAN-agent-in-kernel P0). Every entry is `scope: null`
  // (identity-only): an agent can only ever act **as the human who owns the
  // credential**, so there is no permission key that could widen it. The
  // mutating flag makes MCP callers additionally declare `mcp.write` — the
  // existing meaning of that scope, unchanged.
  {
    id: 'agent.status.read',
    method: 'GET',
    path: '/api/v1/agent/status',
    scope: null,
    summary: '读取 Agent 开关与模型提供方状态',
    mutating: false,
  },
  {
    id: 'agent.model.list',
    method: 'GET',
    path: '/api/v1/agent/models',
    scope: null,
    summary: '读取当前凭证允许使用的 Agent 模型',
    mutating: false,
  },
  {
    id: 'agent.profile.read',
    method: 'GET',
    path: '/api/v1/agent/profiles/:tokenId',
    scope: null,
    summary: '读取本人 API Key 的 Agent 策略',
    mutating: false,
  },
  {
    id: 'agent.run.create',
    method: 'POST',
    path: '/api/v1/agent/runs',
    scope: null,
    summary: 'Start a kernel Agent run as yourself',
    mutating: true,
  },
  {
    id: 'agent.run.list',
    method: 'GET',
    path: '/api/v1/agent/runs',
    scope: null,
    summary: 'List your own kernel Agent runs',
    mutating: false,
  },
  {
    id: 'agent.run.read',
    method: 'GET',
    path: '/api/v1/agent/runs/:id',
    scope: null,
    summary: 'Read one of your own kernel Agent runs and its steps',
    mutating: false,
  },
  {
    id: 'agent.run.resume',
    method: 'POST',
    path: '/api/v1/agent/runs/:id/resume',
    scope: null,
    summary: 'Continue one of your own suspended kernel Agent runs',
    mutating: true,
  },
  {
    id: 'agent.run.cancel',
    method: 'POST',
    path: '/api/v1/agent/runs/:id/cancel',
    scope: null,
    summary: 'Cancel one of your own kernel Agent runs',
    mutating: true,
  },
  {
    id: 'agent.approval.list',
    method: 'GET',
    path: '/api/v1/agent/approvals',
    scope: null,
    summary: 'List tool approvals awaiting your decision',
    mutating: false,
  },
  {
    id: 'agent.approval.decide',
    method: 'POST',
    path: '/api/v1/agent/approvals/:id/decide',
    scope: null,
    summary: 'Approve or deny a pending agent tool call you are eligible to decide',
    mutating: true,
  },

  // ------------------------------------------------------------------------
  // Kernel admin capabilities (ADR-0001: one implementation, two transports).
  //
  // Each entry mirrors an `/admin/*` route one-for-one. The alias is mounted by
  // `lib/capability-alias.ts`, which re-registers the route's *own* handler and
  // preHandler chain — so the coarse `requireRole('ADMIN')` guard still runs
  // first and these refined scopes only ever narrow it. `destructive: false`
  // marks a write the caller can undo by writing the previous value; anything
  // that moves money, destroys data or rotates a key stays `true` and therefore
  // always requires a human session to approve.
  // ------------------------------------------------------------------------
  {
    id: 'admin.users.list',
    method: 'GET',
    path: '/api/v1/admin/users',
    scope: 'user:read',
    summary: 'List users with paging and search (admin view)',
    mutating: false,
  },
  {
    id: 'admin.users.read',
    method: 'GET',
    path: '/api/v1/admin/users/:id',
    scope: 'user:read',
    summary: 'Read one user; params: {id}',
    mutating: false,
  },
  {
    id: 'admin.users.create',
    method: 'POST',
    path: '/api/v1/admin/users',
    scope: 'user:write',
    summary: 'Create a user; body: {email, password?, status?, groupIds?}',
    mutating: true,
    destructive: false,
  },
  {
    id: 'admin.users.update',
    method: 'PATCH',
    path: '/api/v1/admin/users/:id',
    scope: 'user:write',
    summary: "Update a user's status or groups; params: {id}, body: {status?, groupIds?}. Send at least one field.",
    mutating: true,
    destructive: false,
  },
  {
    id: 'admin.users.passwordReset',
    method: 'POST',
    path: '/api/v1/admin/users/:id/reset-password',
    scope: 'user:write',
    summary: "Reset a user's password and revoke sessions; params: {id}, body: {password?}",
    mutating: true,
    destructive: false,
  },
  {
    id: 'admin.users.walletAdjust',
    method: 'POST',
    path: '/api/v1/admin/users/:id/wallet',
    scope: 'user:write',
    summary: "Adjust a user's wallet balance; params: {id}, body: {amount, note?}. Money movement: irreversible.",
    mutating: true,
    destructive: true,
  },
  {
    id: 'admin.users.services.list',
    method: 'GET',
    path: '/api/v1/admin/users/:id/services',
    scope: 'user:read',
    summary: "List a user's services; params: {id}",
    mutating: false,
  },
  {
    id: 'admin.users.services.gift',
    method: 'POST',
    path: '/api/v1/admin/users/:id/services',
    scope: 'user:write',
    summary: 'Gift a service instance to a user; params: {id}, body: {productId, quantity?, expiresAt?}',
    mutating: true,
    destructive: true,
  },
  {
    id: 'admin.users.services.update',
    method: 'PATCH',
    path: '/api/v1/admin/users/:id/services/:serviceId',
    scope: 'user:write',
    summary: "Update a user's service; params: {id, serviceId}",
    mutating: true,
    destructive: false,
  },
  {
    id: 'admin.users.services.delete',
    method: 'DELETE',
    path: '/api/v1/admin/users/:id/services/:serviceId',
    scope: 'user:write',
    summary: "Delete a user's service permanently; params: {id, serviceId}",
    mutating: true,
    destructive: true,
  },
  {
    id: 'admin.users.upstreamServices.list',
    method: 'GET',
    path: '/api/v1/admin/users/:id/upstream-services',
    scope: 'user:read',
    summary: "List a user's upstream (already-purchased) services; params: {id}",
    mutating: false,
  },
  {
    id: 'admin.users.upstreamServices.bind',
    method: 'POST',
    path: '/api/v1/admin/users/:id/upstream-services',
    scope: 'user:write',
    summary: 'Bind an upstream service to a user; params: {id}',
    mutating: true,
    destructive: false,
  },
  {
    id: 'admin.users.upstreamServices.unbind',
    method: 'DELETE',
    path: '/api/v1/admin/users/:id/upstream-services/:serviceId',
    scope: 'user:write',
    summary: 'Unbind an upstream service from a user; params: {id, serviceId}',
    mutating: true,
    destructive: true,
  },
  {
    id: 'admin.users.impersonate',
    method: 'POST',
    path: '/api/v1/admin/users/:id/impersonate',
    scope: 'user:write',
    summary: 'Start an impersonation session for a user; params: {id}. Security-sensitive: acts as that user.',
    mutating: true,
    destructive: true,
  },
  {
    id: 'admin.settings.list',
    method: 'GET',
    path: '/api/v1/admin/settings',
    scope: 'settings:read',
    summary: 'List every platform setting',
    mutating: false,
  },
  {
    id: 'admin.settings.write',
    method: 'PUT',
    path: '/api/v1/admin/settings/:key',
    scope: 'settings:write',
    summary: 'Set one platform setting; params: {key}, body: {value}. Reversible by writing the previous value.',
    mutating: true,
    destructive: false,
  },
  {
    id: 'admin.plugins.list',
    method: 'GET',
    path: '/api/v1/admin/plugins',
    scope: 'plugins:read',
    summary: 'List installed plugins with state and manifest',
    mutating: false,
  },
  {
    id: 'admin.plugins.update',
    method: 'PATCH',
    path: '/api/v1/admin/plugins/:id',
    scope: 'plugins:write',
    summary: 'Enable/disable or configure a plugin; params: {id}',
    mutating: true,
    destructive: false,
  },
  {
    id: 'admin.plugins.delete',
    method: 'DELETE',
    path: '/api/v1/admin/plugins/:id',
    scope: 'plugins:write',
    summary: 'Uninstall a plugin and drop its data; params: {id}',
    mutating: true,
    destructive: true,
  },
  {
    id: 'admin.plugins.upload',
    method: 'POST',
    path: '/api/v1/admin/plugins/upload',
    scope: 'plugins:write',
    summary: 'Install a plugin package (multipart upload); mutating and hard to undo',
    mutating: true,
    destructive: true,
  },
  {
    id: 'admin.plugins.settings.read',
    method: 'GET',
    path: '/api/v1/admin/plugins/:id/settings',
    scope: 'plugins:read',
    summary: "Read a plugin's settings; params: {id}",
    mutating: false,
  },
  {
    id: 'admin.plugins.settings.write',
    method: 'PATCH',
    path: '/api/v1/admin/plugins/:id/settings',
    scope: 'plugins:write',
    summary: "Update a plugin's settings; params: {id}",
    mutating: true,
    destructive: false,
  },
  {
    id: 'admin.rbac.permissions',
    method: 'GET',
    path: '/api/v1/admin/permissions',
    scope: 'rbac:read',
    summary: 'List every declared permission and its holders',
    mutating: false,
  },
  {
    id: 'admin.rbac.groups.list',
    method: 'GET',
    path: '/api/v1/admin/permission-groups',
    scope: 'rbac:read',
    summary: 'List permission groups',
    mutating: false,
  },
  {
    id: 'admin.rbac.groups.create',
    method: 'POST',
    path: '/api/v1/admin/permission-groups',
    scope: 'rbac:write',
    summary: 'Create a permission group',
    mutating: true,
    destructive: false,
  },
  {
    id: 'admin.rbac.groups.update',
    method: 'PATCH',
    path: '/api/v1/admin/permission-groups/:id',
    scope: 'rbac:write',
    summary: "Update a permission group's members or permissions; params: {id}",
    mutating: true,
    destructive: false,
  },
  {
    id: 'admin.rbac.groups.delete',
    method: 'DELETE',
    path: '/api/v1/admin/permission-groups/:id',
    scope: 'rbac:write',
    summary: 'Delete a permission group; params: {id}',
    mutating: true,
    destructive: true,
  },
  {
    id: 'admin.rbac.templates',
    method: 'GET',
    path: '/api/v1/admin/rbac/templates',
    scope: 'rbac:read',
    summary: 'List role templates contributed by active plugins',
    mutating: false,
  },
  {
    id: 'admin.audit.read',
    method: 'GET',
    path: '/api/v1/admin/audit-log',
    scope: 'audit:read',
    summary: 'Read the platform audit log with paging and filters',
    mutating: false,
  },
  {
    id: 'admin.jobs.schedules',
    method: 'GET',
    path: '/api/v1/admin/jobs/schedules',
    scope: 'jobs:read',
    summary: 'List scheduled kernel jobs and their next run',
    mutating: false,
  },
  {
    id: 'admin.jobs.deadLetter',
    method: 'GET',
    path: '/api/v1/admin/jobs/dead-letter',
    scope: 'jobs:read',
    summary: 'List jobs that exhausted their retries',
    mutating: false,
  },
  {
    id: 'admin.jobs.retry',
    method: 'POST',
    path: '/api/v1/admin/jobs/dead-letter/:id/retry',
    scope: 'jobs:write',
    summary: 'Requeue a dead-lettered job; params: {id}',
    mutating: true,
    destructive: false,
  },
  {
    id: 'admin.currency.list',
    method: 'GET',
    path: '/api/v1/admin/currency-rates',
    scope: 'currency:read',
    summary: 'List currency definitions and exchange rates',
    mutating: false,
  },
  {
    id: 'admin.currency.write',
    method: 'PUT',
    path: '/api/v1/admin/currency-rates',
    scope: 'currency:write',
    summary: 'Upsert a currency rate; body: {base, quote, rate, ...}',
    mutating: true,
    destructive: false,
  },
  {
    id: 'admin.currency.delete',
    method: 'DELETE',
    path: '/api/v1/admin/currency-rates',
    scope: 'currency:write',
    summary: 'Delete a currency rate; body identifies the pair',
    mutating: true,
    destructive: true,
  },
  {
    id: 'admin.sales.channels.list',
    method: 'GET',
    path: '/api/v1/admin/sales-channels',
    scope: 'sales:read',
    summary: 'List sales channels',
    mutating: false,
  },
  {
    id: 'admin.sales.channels.create',
    method: 'POST',
    path: '/api/v1/admin/sales-channels',
    scope: 'sales:write',
    summary: 'Create a sales channel',
    mutating: true,
    destructive: false,
  },
  {
    id: 'admin.sales.channels.update',
    method: 'PATCH',
    path: '/api/v1/admin/sales-channels/:id',
    scope: 'sales:write',
    summary: 'Update a sales channel; params: {id}',
    mutating: true,
    destructive: false,
  },
  {
    id: 'admin.sales.channels.delete',
    method: 'DELETE',
    path: '/api/v1/admin/sales-channels/:id',
    scope: 'sales:write',
    summary: 'Delete a sales channel; params: {id}',
    mutating: true,
    destructive: true,
  },
  {
    id: 'admin.sales.paymentMethods.create',
    method: 'POST',
    path: '/api/v1/admin/payment-methods',
    scope: 'sales:write',
    summary: 'Create a payment method',
    mutating: true,
    destructive: false,
  },
  {
    id: 'admin.sales.paymentMethods.update',
    method: 'PATCH',
    path: '/api/v1/admin/payment-methods/:id',
    scope: 'sales:write',
    summary: 'Update a payment method; params: {id}',
    mutating: true,
    destructive: false,
  },
  {
    id: 'admin.sales.paymentMethods.delete',
    method: 'DELETE',
    path: '/api/v1/admin/payment-methods/:id',
    scope: 'sales:write',
    summary: 'Delete a payment method; params: {id}',
    mutating: true,
    destructive: true,
  },
  {
    id: 'admin.payments.list',
    method: 'GET',
    path: '/api/v1/admin/payments',
    scope: 'payment:read',
    summary: 'List manual settlement records',
    mutating: false,
  },
  {
    id: 'admin.payments.confirm',
    method: 'POST',
    path: '/api/v1/admin/payments/:id/confirm',
    scope: 'payment:write',
    summary: 'Confirm a manual payment and settle the order; params: {id}. Moves money.',
    mutating: true,
    destructive: true,
  },
  {
    id: 'admin.payments.cancel',
    method: 'POST',
    path: '/api/v1/admin/payments/:id/cancel',
    scope: 'payment:write',
    summary: 'Cancel a pending manual payment; params: {id}',
    mutating: true,
    destructive: false,
  },
  {
    id: 'admin.notifications.policy.read',
    method: 'GET',
    path: '/api/v1/admin/notifications/policy',
    scope: 'notification:read',
    summary: 'Read the notification delivery policy',
    mutating: false,
  },
  {
    id: 'admin.notifications.policy.write',
    method: 'PUT',
    path: '/api/v1/admin/notifications/policy',
    scope: 'notification:write',
    summary: 'Update the notification delivery policy',
    mutating: true,
    destructive: false,
  },
  {
    id: 'admin.secrets.list',
    method: 'GET',
    path: '/api/v1/admin/secrets',
    scope: 'secret:read',
    summary: 'List secret names (never values)',
    mutating: false,
  },
  {
    id: 'admin.secrets.read',
    method: 'GET',
    path: '/api/v1/admin/secrets/:key',
    scope: 'secret:read',
    summary: 'Check whether a secret exists; params: {key}. Values are never returned.',
    mutating: false,
  },
  {
    id: 'admin.secrets.write',
    method: 'PUT',
    path: '/api/v1/admin/secrets/:key',
    scope: 'secret:write',
    summary: 'Set an encrypted secret; params: {key}, body: {value}',
    mutating: true,
    destructive: true,
  },
  {
    id: 'admin.signing.read',
    method: 'GET',
    path: '/api/v1/admin/signing',
    scope: 'signing:read',
    summary: 'Read the platform signing key metadata',
    mutating: false,
  },
  {
    id: 'admin.signing.rotate',
    method: 'PATCH',
    path: '/api/v1/admin/signing',
    scope: 'signing:write',
    summary: 'Rotate the platform signing key. Invalidates tokens signed with the old key.',
    mutating: true,
    destructive: true,
  },
  {
    id: 'admin.distribution.source.read',
    method: 'GET',
    path: '/api/v1/admin/distribution/source',
    scope: 'distribution:read',
    summary: 'Read the distribution catalog source configuration',
    mutating: false,
  },
  {
    id: 'admin.distribution.source.write',
    method: 'PUT',
    path: '/api/v1/admin/distribution/source',
    scope: 'distribution:write',
    summary: 'Update the distribution catalog source',
    mutating: true,
    destructive: false,
  },
  {
    id: 'admin.distribution.catalogKey',
    method: 'PUT',
    path: '/api/v1/admin/distribution/catalog-key',
    scope: 'distribution:write',
    summary: 'Replace the trusted catalog signing key',
    mutating: true,
    destructive: true,
  },
  {
    id: 'admin.distribution.token',
    method: 'PUT',
    path: '/api/v1/admin/distribution/token',
    scope: 'distribution:write',
    summary: 'Replace the distribution access token',
    mutating: true,
    destructive: true,
  },
  {
    id: 'admin.distribution.refresh',
    method: 'POST',
    path: '/api/v1/admin/distribution/refresh',
    scope: 'distribution:write',
    summary: 'Refresh the distribution catalog from its source',
    mutating: true,
    destructive: false,
  },
  {
    id: 'admin.distribution.reload',
    method: 'POST',
    path: '/api/v1/admin/distribution/reload',
    scope: 'distribution:write',
    summary: 'Reload the cached distribution catalog',
    mutating: true,
    destructive: false,
  },
  {
    id: 'admin.updates.status',
    method: 'GET',
    path: '/api/v1/admin/updates/status',
    scope: 'update:read',
    summary: 'Read updater status and available versions',
    mutating: false,
  },
  {
    id: 'admin.updates.policy.read',
    method: 'GET',
    path: '/api/v1/admin/updates/policy',
    scope: 'update:read',
    summary: 'Read the auto-update policy',
    mutating: false,
  },
  {
    id: 'admin.updates.policy.write',
    method: 'PUT',
    path: '/api/v1/admin/updates/policy',
    scope: 'update:write',
    summary: 'Update the auto-update policy',
    mutating: true,
    destructive: false,
  },
  {
    id: 'admin.updates.results',
    method: 'GET',
    path: '/api/v1/admin/updates/results',
    scope: 'update:read',
    summary: 'List update results',
    mutating: false,
  },
  {
    id: 'admin.updates.result.read',
    method: 'GET',
    path: '/api/v1/admin/updates/results/:key',
    scope: 'update:read',
    summary: 'Read one update result; params: {key}',
    mutating: false,
  },
  {
    id: 'admin.updates.check',
    method: 'POST',
    path: '/api/v1/admin/updates/check',
    scope: 'update:write',
    summary: 'Check for available updates',
    mutating: true,
    destructive: false,
  },
  {
    id: 'admin.updates.plan',
    method: 'POST',
    path: '/api/v1/admin/updates/plan',
    scope: 'update:write',
    summary: 'Solve an update plan without applying it',
    mutating: true,
    destructive: false,
  },
  {
    id: 'admin.updates.submit',
    method: 'POST',
    path: '/api/v1/admin/updates/submit',
    scope: 'update:write',
    summary: 'Apply an update plan. Can run irreversible migrations.',
    mutating: true,
    destructive: true,
  },
  {
    id: 'admin.updates.selfUpdate.read',
    method: 'GET',
    path: '/api/v1/admin/updates/self-update',
    scope: 'update:read',
    summary: 'Read kernel self-update progress',
    mutating: false,
  },
  {
    id: 'admin.updates.selfUpdate.start',
    method: 'POST',
    path: '/api/v1/admin/updates/self-update',
    scope: 'update:write',
    summary: 'Start a kernel self-update. Restarts the process.',
    mutating: true,
    destructive: true,
  },
  {
    id: 'admin.updates.selfUpdate.cancel',
    method: 'DELETE',
    path: '/api/v1/admin/updates/self-update',
    scope: 'update:write',
    summary: 'Cancel a pending kernel self-update',
    mutating: true,
    destructive: false,
  },
  {
    id: 'admin.agent.model.read',
    method: 'GET',
    path: '/api/v1/admin/agent/model',
    scope: 'agent:read',
    summary: 'Read the Agent fallback LLM endpoint configuration',
    mutating: false,
  },
  {
    id: 'admin.agent.model.write',
    method: 'PUT',
    path: '/api/v1/admin/agent/model',
    scope: 'agent:write',
    summary: 'Set the Agent fallback LLM endpoint (baseUrl, model, apiKey)',
    mutating: true,
    destructive: false,
  },
  {
    id: 'admin.agent.model.delete',
    method: 'DELETE',
    path: '/api/v1/admin/agent/model',
    scope: 'agent:write',
    summary: 'Delete the Agent fallback LLM endpoint and its stored API key',
    mutating: true,
    destructive: true,
  },
  {
    id: 'admin.agent.model.catalog',
    method: 'GET',
    path: '/api/v1/admin/agent/model/catalog',
    scope: 'agent:read',
    summary: 'Read the live model catalogue advertised by the active provider',
    mutating: false,
  },
  {
    id: 'admin.agent.model.default',
    method: 'PUT',
    path: '/api/v1/admin/agent/model/default',
    scope: 'agent:write',
    summary: 'Set the default model the Agent runs with; body: {model|null}',
    mutating: true,
    destructive: false,
  },
  {
    id: 'admin.ui.actions',
    method: 'GET',
    path: '/api/v1/admin/ui/actions',
    scope: 'settings:read',
    summary: 'List UI action descriptors contributed by plugins',
    mutating: false,
  },
  {
    id: 'admin.ui.widgets',
    method: 'GET',
    path: '/api/v1/admin/ui/widgets',
    scope: 'settings:read',
    summary: 'List UI widget descriptors contributed by plugins',
    mutating: false,
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
  governance: ScopeGovernance = KERNEL_RESOURCE_PERMISSIONS,
  /**
   * API tokens must explicitly carry a refined `resource:read|write` scope.
   * Sessions are evaluated against their full coarse permission set instead.
   */
  requireExactRefinedScopes = false,
): Capability[] {
  const owned = permissions instanceof Set ? permissions : new Set(permissions);
  return [...CAPABILITIES, ...pluginCapabilities].filter((cap) => {
    if (cap.scope === null) return true;
    if (requireExactRefinedScopes && scopeResource(cap.scope)) {
      return refinedScopes.includes(cap.scope);
    }
    if (scopeSatisfied(cap.scope, owned, governance)) return true;
    return refinedScopes.includes(cap.scope);
  });
}

/**
 * The `/admin/...` path an admin capability mirrors, or `null` if the path is
 * not an admin alias.
 *
 * `capability-alias.ts` keys off this to decide which capabilities it must mount
 * on the Fastify instance: they are the only ones whose handler lives at a
 * different URL than the capability's public `path`.
 */
export function adminInternalPathOf(path: string): string | null {
  return path.startsWith('/api/v1/admin/') ? path.slice('/api/v1'.length) : null;
}

/**
 * Admin capabilities indexed by the internal route they mirror (`"GET /admin/users"`).
 *
 * Built on demand so a capability added to {@link CAPABILITIES} is picked up
 * automatically — there is no second list to keep in sync.
 */
export function adminCapabilityByRoute(): Map<string, Capability> {
  const map = new Map<string, Capability>();
  for (const capability of CAPABILITIES) {
    const internal = adminInternalPathOf(capability.path);
    if (!internal) continue;
    map.set(`${capability.method} ${internal}`, capability);
  }
  return map;
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
