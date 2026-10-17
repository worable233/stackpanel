import { describe, expect, it } from 'vitest';
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
});
