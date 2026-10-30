import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  KERNEL_RESOURCE_PERMISSIONS,
  adminCapabilityByRoute,
  adminInternalPathOf,
  capabilitiesFor,
  scopeSatisfied,
} from '../../src/lib/capability-registry.ts';

/**
 * Kernel admin capabilities (the `/api/v1/admin/*` mirror of `/admin/*`).
 *
 * Three invariants are locked here, because breaking any of them silently
 * widens or empties the open-platform surface:
 *
 * 1. **Every admin capability mirrors exactly one internal route.** The alias
 *    installer mounts the route whose `method + url` matches
 *    `adminInternalPathOf(capability.path)`. A typo would leave the capability
 *    advertised in `GET /api/v1/capabilities` but unroutable.
 * 2. **Undeclared writes cannot slip through.** Anything that is not a GET must
 *    be `mutating: true`, otherwise it would skip `Idempotency-Key` handling.
 * 3. **Refined scopes narrow, never widen.** A token that carries only
 *    `settings:read` must not see `settings:write` capabilities, and a token
 *    carrying only the coarse `platform.admin` must not see refined ones —
 *    refined scopes are opt-in.
 */
describe('kernel admin capabilities', () => {
  const admin = adminCapabilityByRoute();

  it('declares at least one capability per admin surface family', () => {
    expect(admin.size).toBeGreaterThan(50);
    for (const resource of [
      'users',
      'settings',
      'plugins',
      'permission-groups',
      'audit-log',
      'jobs',
      'currency-rates',
      'sales-channels',
      'payments',
      'notifications',
      'secrets',
      'signing',
      'distribution',
      'updates',
      'agent',
      'ui',
    ]) {
      const found = [...admin.values()].filter((cap) => cap.path.includes(`/admin/${resource}`));
      expect(found.length, `no admin capability for ${resource}`).toBeGreaterThan(0);
    }
  });

  it('mirrors only /admin/* paths and never the public alias itself', () => {
    for (const cap of admin.values()) {
      const internal = adminInternalPathOf(cap.path);
      expect(internal, `${cap.id} is not an admin path`).not.toBeNull();
      expect(internal?.startsWith('/admin/'), cap.id).toBe(true);
      // Re-deriving the public path must round-trip, or the alias is unmountable.
      expect(`/api/v1${internal}`).toBe(cap.path);
    }
  });

  it('marks every non-GET capability as mutating', () => {
    for (const cap of admin.values()) {
      if (cap.method === 'GET') continue;
      expect(cap.mutating, `${cap.id} (${cap.method}) must be mutating`).toBe(true);
    }
  });

  it('gives every capability a refined resource scope the kernel governs', () => {
    for (const cap of admin.values()) {
      expect(cap.scope, `${cap.id} has no scope`).toBeTruthy();
      const resource = String(cap.scope).split(':')[0]!;
      expect(
        KERNEL_RESOURCE_PERMISSIONS[resource],
        `${cap.id} uses ungoverned resource ${resource}`,
      ).toBeDefined();
      // Admin surfaces are admin-only by design; the coarse key must be present
      // or `scopeSatisfied` would admit nobody (scope becomes dead weight).
      expect(KERNEL_RESOURCE_PERMISSIONS[resource]).toContain('platform.admin');
    }
  });

  it('never advertises a write capability to a read-only refined token', () => {
    const visible = capabilitiesFor(
      new Set<string>(),
      [],
      ['settings:read'],
      KERNEL_RESOURCE_PERMISSIONS,
      true,
    );
    const ids = visible.map((cap) => cap.id);
    expect(ids).toContain('admin.settings.list');
    expect(ids).not.toContain('admin.settings.write');
    // A read scope on one resource must not unlock another resource.
    expect(ids).not.toContain('admin.plugins.list');
  });

  it('does not advertise refined capabilities to a coarse-only token', () => {
    const visible = capabilitiesFor(
      new Set(['platform.admin']),
      [],
      [],
      KERNEL_RESOURCE_PERMISSIONS,
      true,
    );
    expect(visible.some((cap) => cap.id.startsWith('admin.'))).toBe(false);
  });

  it('lets an admin session satisfy the refined scope without a refined token', () => {
    // Sessions are evaluated against their coarse permission set, so the same
    // capability the token path treats as opt-in stays reachable for a human
    // admin — otherwise the admin UI would break.
    for (const cap of admin.values()) {
      expect(
        scopeSatisfied(String(cap.scope), new Set(['platform.admin']), KERNEL_RESOURCE_PERMISSIONS),
        cap.id,
      ).toBe(true);
    }
  });

  it('keeps admin and kernel capability ids unique', () => {
    const ids = CAPABILITIES.map((cap) => cap.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
