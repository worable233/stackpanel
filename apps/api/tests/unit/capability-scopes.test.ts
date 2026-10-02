import { describe, expect, it } from 'vitest';
import {
  RESOURCE_PERMISSIONS,
  canGrantScope,
  capabilitiesFor,
  grantableScopesFor,
  scopeResource,
  scopeSatisfied,
  type Capability,
} from '../../src/lib/capability-registry.ts';

/**
 * Refined `资源:read|write` scope semantics (PLAN-open-platform P1 slice four).
 *
 * These lock the two invariants the slice turns on: a coarse permission gates a
 * resource but a coarse-only token cannot perform a refined operation, and a
 * read scope can never satisfy a write scope. A regression here would silently
 * widen the open API surface.
 */
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
    expect(scopeSatisfied('gateway:read', new Set(['llm-gateway.use']))).toBe(true);
    expect(scopeSatisfied('gateway:write', new Set(['llm-gateway.admin']))).toBe(true);
  });

  it('does not let a refined read scope satisfy a write scope', () => {
    expect(scopeSatisfied('user:write', new Set(['user:read']))).toBe(false);
    expect(scopeSatisfied('gateway:write', new Set(['gateway:read']))).toBe(false);
  });

  it('matches non-refined scopes exactly (slice one/two/three preserved)', () => {
    expect(scopeSatisfied('store.admin', new Set(['store.admin']))).toBe(true);
    expect(scopeSatisfied('store.admin', new Set(['platform.admin']))).toBe(false);
    expect(scopeSatisfied(null, new Set())).toBe(true);
  });

  it('only grants refined scopes the owner already governs', () => {
    expect(canGrantScope('user:read', new Set(['platform.admin']))).toBe(true);
    expect(canGrantScope('user:write', new Set(['llm-gateway.use']))).toBe(false);
    expect(canGrantScope('gateway:write', new Set(['llm-gateway.use']))).toBe(true);
    expect(canGrantScope('platform.admin', new Set(['llm-gateway.use']))).toBe(false);
  });

  it('expands the grantable set with the refined scopes of governed resources', () => {
    const grantable = grantableScopesFor(new Set(['platform.admin', 'llm-gateway.use']));
    expect(grantable).toContain('platform.admin');
    expect(grantable).toContain('user:read');
    expect(grantable).toContain('user:write');
    expect(grantable).toContain('gateway:read');
    expect(grantable).toContain('gateway:write');
    // Sorted and de-duplicated.
    expect(grantable).toEqual([...grantable].sort());
    expect(new Set(grantable).size).toBe(grantable.length);
  });

  it('exposes every resource in the mapping with at least one coarse permission', () => {
    for (const [resource, coarse] of Object.entries(RESOURCE_PERMISSIONS)) {
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
