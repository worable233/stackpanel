import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
import {
  KERNEL_RESOURCE_PERMISSIONS,
  RESOURCE_PERMISSIONS,
  aggregateScopeGovernance,
  canGrantScope,
  capabilitiesFor,
  grantableScopesFor,
  mergeScopeGovernance,
  scopeResource,
  scopeSatisfied,
  type Capability,
  type ScopeGovernance,
} from '../../src/lib/capability-registry.ts';

/**
 * Refined `资源:read|write` scope semantics (PLAN-open-platform P1 slice four;
 * governance table de-hardcoded in ADR-0021).
 *
 * These lock the two invariants the slice turns on: a coarse permission gates a
 * resource but a coarse-only token cannot perform a refined operation, and a
 * read scope can never satisfy a write scope. A regression here would silently
 * widen the open API surface.
 *
 * ADR-0021: the kernel no longer hardcodes plugin permission keys. A *plugin*
 * resource is only governed when its owner declares `PluginPermission.scope`
 * and the runtime passes the aggregated table in. Without it, only the kernel
 * baseline applies — fail-closed.
 */

/** A plugin-declared governance table, as `PluginRuntime` aggregates it. */
const PLUGIN_GOVERNANCE: ScopeGovernance = { gateway: ['llm-gateway.use', 'llm-gateway.admin'] };

describe('refined open-API scopes', () => {
  it('recognises the resource part of a refined scope', () => {
    expect(scopeResource('user:read')).toBe('user');
    expect(scopeResource('gateway:write')).toBe('gateway');
    // Coarse permission keys use a dot; they are not refined scopes.
    expect(scopeResource('platform.admin')).toBeNull();
    expect(scopeResource('admin')).toBeNull();
  });

  it('lets a coarse resource permission satisfy its refined scopes (session semantics)', () => {
    expect(scopeSatisfied('user:read', new Set(['platform.admin']))).toBe(true);
    expect(scopeSatisfied('user:write', new Set(['platform.manage.users']))).toBe(true);
    // Plugin resource: satisfied only once its governance is supplied.
    expect(scopeSatisfied('gateway:read', new Set(['llm-gateway.use']), PLUGIN_GOVERNANCE)).toBe(true);
    expect(scopeSatisfied('gateway:write', new Set(['llm-gateway.admin']), PLUGIN_GOVERNANCE)).toBe(true);
  });

  it('does not let a refined read scope satisfy a write scope', () => {
    expect(scopeSatisfied('user:write', new Set(['user:read']))).toBe(false);
    expect(scopeSatisfied('gateway:write', new Set(['gateway:read']), PLUGIN_GOVERNANCE)).toBe(false);
  });

  it('matches non-refined scopes exactly (slice one/two/three preserved)', () => {
    expect(scopeSatisfied('store.admin', new Set(['store.admin']))).toBe(true);
    expect(scopeSatisfied('store.admin', new Set(['platform.admin']))).toBe(false);
    expect(scopeSatisfied(null, new Set())).toBe(true);
  });

  it('fail-closes a plugin resource when its governance is absent (ADR-0021)', () => {
    // The kernel baseline knows only `user`; `gateway` is a plugin resource.
    expect(RESOURCE_PERMISSIONS).toBe(KERNEL_RESOURCE_PERMISSIONS);
    expect(scopeSatisfied('gateway:read', new Set(['llm-gateway.use']))).toBe(false);
    expect(canGrantScope('gateway:write', new Set(['llm-gateway.admin']))).toBe(false);
  });

  it('only grants refined scopes the owner already governs', () => {
    expect(canGrantScope('user:read', new Set(['platform.admin']))).toBe(true);
    expect(canGrantScope('user:write', new Set(['llm-gateway.use']))).toBe(false);
    expect(canGrantScope('gateway:write', new Set(['llm-gateway.use']), PLUGIN_GOVERNANCE)).toBe(true);
    expect(canGrantScope('platform.admin', new Set(['llm-gateway.use']))).toBe(false);
  });

  it('expands the grantable set with the refined scopes of governed resources', () => {
    const grantable = grantableScopesFor(
      new Set(['platform.admin', 'llm-gateway.use']),
      mergeScopeGovernance(KERNEL_RESOURCE_PERMISSIONS, PLUGIN_GOVERNANCE),
    );
    expect(grantable).toContain('platform.admin');
    expect(grantable).toContain('user:read');
    expect(grantable).toContain('user:write');
    expect(grantable).toContain('gateway:read');
    expect(grantable).toContain('gateway:write');
    // Sorted and de-duplicated.
    expect(grantable).toEqual([...grantable].sort());
    expect(new Set(grantable).size).toBe(grantable.length);
  });

  it('merges governance tables additive and without dropping the kernel baseline', () => {
    const merged = mergeScopeGovernance(KERNEL_RESOURCE_PERMISSIONS, PLUGIN_GOVERNANCE, undefined);
    expect(merged.user).toEqual(KERNEL_RESOURCE_PERMISSIONS.user);
    expect(merged.gateway).toEqual(PLUGIN_GOVERNANCE.gateway);
    // De-duplicates keys when two plugins declare the same resource.
    const again = mergeScopeGovernance(PLUGIN_GOVERNANCE, {
      gateway: ['llm-gateway.use'],
    });
    const gateway = again.gateway ?? [];
    expect(new Set(gateway).size).toBe(gateway.length);
  });

  it('aggregates plugin-declared scope governance on top of the kernel baseline (ADR-0021)', () => {
    const merged = aggregateScopeGovernance([
      // Mirrors llm-gateway: object permissions with a `scope`.
      [
        { key: 'llm-gateway.use', scope: 'gateway' },
        { key: 'llm-gateway.admin', scope: 'gateway' },
      ],
      // Bare strings and scope-less objects contribute nothing.
      ['store.admin', { key: 'catalog.read' }],
      // A second plugin declaring the same resource adds without dropping.
      [{ key: 'gateway.audit', scope: 'gateway' }],
    ]);
    expect(merged.user).toEqual(KERNEL_RESOURCE_PERMISSIONS.user);
    expect(new Set(merged.gateway)).toEqual(
      new Set(['llm-gateway.use', 'llm-gateway.admin', 'gateway.audit']),
    );
    // With the aggregated table, the plugin resource is governed again.
    expect(canGrantScope('gateway:read', new Set(['llm-gateway.use']), merged)).toBe(true);
  });

  it('exposes every resource in the kernel baseline with at least one coarse permission', () => {
    for (const [resource, coarse] of Object.entries(KERNEL_RESOURCE_PERMISSIONS)) {
      expect(resource.length).toBeGreaterThan(0);
      expect(coarse.length).toBeGreaterThan(0);
    }
  });

  it('discovers refined capabilities from a token scope without a coarse permission', () => {
    const capability: Capability = {
      id: 'user.list',
      method: 'GET',
      path: '/api/v1/users',
      scope: 'user:read',
      summary: 'List users',
      mutating: false,
    };
    const ids = (refined: readonly string[]): string[] =>
      capabilitiesFor(new Set(), [capability], refined).map((cap) => cap.id);
    // A token whose owner was demoted holds no coarse permission …
    expect(ids([])).not.toContain('user.list');
    // … but its refined scope still surfaces the read capability.
    expect(ids(['user:read'])).toContain('user.list');
    expect(ids(['user:write'])).not.toContain('user.list');
  });

  it('does not advertise refined capabilities to a coarse-only API token', () => {
    const capability: Capability = {
      id: 'user.create',
      method: 'POST',
      path: '/api/v1/users',
      scope: 'user:write',
      summary: 'Create a user',
      mutating: true,
    };
    const coarseOnly = new Set(['platform.manage.users']);

    // A browser session may act through its full delegated role.
    expect(capabilitiesFor(coarseOnly, [capability]).map((cap) => cap.id)).toContain('user.create');
    // A token must name `user:write`, matching requireOpenScope at execution.
    expect(
      capabilitiesFor(coarseOnly, [capability], ['platform.manage.users'], undefined, true).map(
        (cap) => cap.id,
      ),
    ).not.toContain('user.create');
  });
});

describe('plugin resources must not lock out the superuser', () => {
  /**
   * 内核资源在 `KERNEL_RESOURCE_PERMISSIONS` 里逐条列了 `platform.admin`，所以
   * 「超权自动生效」看起来是通用规则 —— 但那只是**手工枚举**的结果。
   *
   * 插件资源是运行期聚合的（`aggregateScopeGovernance`），只把插件自己声明的
   * 权限键填进去，没有 `platform.admin`。于是同一句话在两类资源上结论相反：
   *
   *     user:read    + platform.admin -> true    （内核资源）
   *     gateway:read + platform.admin -> false   （插件资源）
   *
   * 后果是超级管理员访问插件开放 API 一律 403：`requireOpenScope` 对会话用户
   * 直接用 `scopeSatisfied` 判定。
   */
  it('aggregated plugin governance omits platform.admin', () => {
    const gov = aggregateScopeGovernance([
      [
        { key: 'llm-gateway.use', scope: 'gateway' },
        { key: 'llm-gateway.admin', scope: 'gateway' },
      ],
    ] as never);
    expect(gov.gateway).not.toContain('platform.admin');
  });

  it('platform.admin satisfies a plugin refined scope anyway', () => {
    expect(scopeSatisfied('gateway:read', new Set(['platform.admin']), PLUGIN_GOVERNANCE)).toBe(true);
    expect(scopeSatisfied('gateway:write', new Set(['platform.admin']), PLUGIN_GOVERNANCE)).toBe(true);
    // 内核对照：本来就该通过
    expect(scopeSatisfied('user:read', new Set(['platform.admin']))).toBe(true);
  });

  it('does not grant refined scopes to non-superusers', () => {
    expect(scopeSatisfied('gateway:read', new Set(['store.admin']), PLUGIN_GOVERNANCE)).toBe(false);
    expect(scopeSatisfied('gateway:read', new Set(), PLUGIN_GOVERNANCE)).toBe(false);
    expect(scopeSatisfied('gateway:read', new Set(['user.basic']), PLUGIN_GOVERNANCE)).toBe(false);
  });

  it('keeps coarse (non-refined) scopes exact — no automatic escalation', () => {
    // `platform.admin` 是权限键，不是 refined scope。放开它会变成
    // 「持有 A 就自动持有 B」的真正提权。
    expect(scopeSatisfied('store.admin', new Set(['platform.admin']))).toBe(false);
    expect(scopeSatisfied('epay.admin', new Set(['platform.admin']))).toBe(false);
  });
});

describe('capability.scope may only narrow, never widen', () => {
  /**
   * `runtime.ts` 原本无条件用 `capability.scope` 替换 `route.permission`：
   *
   *     ...(!capability.scope && route.permission ? { permission: route.permission } : {})
   *
   * 于是一个抄错的 scope 就能**放宽**访问：
   *
   *     route.permission = 'epay.admin'
   *     capability.scope = 'user.basic'
   *     -> 持有 user.basic 的普通用户可访问管理端点
   *
   * 现在只有 refined `资源:read|write` 才替换；其他形式保留 `route.permission`。
   */
  const runtime = readFileSync(path.join(root, 'src/plugins/runtime.ts'), 'utf8');

  it('decides replacement by scopeResource(), not by truthiness', () => {
    expect(runtime).toContain('scopeResource(capability.scope)');
    expect(runtime).toContain('scopeReplacesPermission');
    // 旧的无条件丢弃必须已经消失。注意注释里仍保留这行作为「以前是什么」的
    // 说明，所以要排除注释行再看实际代码。
    const code = runtime
      .split('\n')
      .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
      .join('\n');
    expect(code).not.toContain(
      '!capability.scope && route.permission ? { permission: route.permission }',
    );
  });

  it('non-refined scope keeps the internal permission gate', () => {
    const i = runtime.indexOf('const scopeReplacesPermission');
    const block = runtime.slice(i, i + 700);
    expect(block).toMatch(/scopeReplacesPermission\s*=\s*refinedScope !== null/);
    // permission 只在「不替换」时保留
    expect(block).toContain('route.permission && !scopeReplacesPermission');
  });
});

describe('capability.scope 规范（防止再写成权限键）', () => {
  /**
   * `capability.scope` 的契约是 refined `资源:read|write`（见
   * `PluginCapability.scope`）。历史上 13 个插件把它写成了权限键
   * （`epay.admin`、`ticket.admin`、`store.admin` …），内核又**完全不校验**
   * 这个字段，于是错写法长期存在。
   *
   * 错写法之所以「看起来能跑」纯属巧合：`scopeSatisfied` 对非 refined scope
   * 走精确匹配，而它们恰好等于自己的 `route.permission`。真正的危害有两个：
   *
   * 1. `runtime.ts` 曾无条件用 `capability.scope` 替换 `route.permission`，
   *    写错就是一个放宽口子（已在上一组用例锁住）。
   * 2. 写错时超级管理员仍然被挡在外面（`platform.admin` 只匹配 refined）。
   *
   * 这组用例把「规范长什么样」写成可执行的断言，插件仓的 CI 可以直接复用。
   */
  it('refined scope 只允许 read / write 两种动作', () => {
    expect(scopeResource('epay:read')).toBe('epay');
    expect(scopeResource('epay:write')).toBe('epay');
    // 权限键没有冒号 -> 不是 refined scope
    expect(scopeResource('epay.admin')).toBeNull();
    expect(scopeResource('ticket.admin')).toBeNull();
  });

  it('写错成权限键时超级管理员仍被挡住（这就是为什么要规范）', () => {
    expect(scopeSatisfied('epay.admin', new Set(['platform.admin']))).toBe(false);
    // 同样的资源，写成 refined 就正常
    expect(scopeSatisfied('epay:read', new Set(['platform.admin']), { epay: ['epay.admin'] })).toBe(
      true,
    );
  });

  it('权限声明带 scope 后，持有者才拿得到 refined scope', () => {
    const withoutScope = aggregateScopeGovernance([[{ key: 'epay.admin' }]] as never);
    expect(grantableScopesFor(new Set(['epay.admin']), withoutScope)).not.toContain('epay:read');

    const withScope = aggregateScopeGovernance([
      [{ key: 'epay.admin', scope: 'epay' }],
    ] as never);
    const grantable = grantableScopesFor(new Set(['epay.admin']), withScope);
    expect(grantable).toContain('epay:read');
    expect(grantable).toContain('epay:write');
  });
});
