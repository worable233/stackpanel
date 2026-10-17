import { describe, expect, it } from 'vitest';
import type { DeploymentPlan } from '@stackpanel/spec';
import { decideAutoUpdate } from '../../src/updates/auto.ts';
import { normalizeUpdatePolicy } from '../../src/updates/policy.ts';

function plan(overrides: Partial<DeploymentPlan> = {}): DeploymentPlan {
  return {
    kernel: { version: '0.2.0', digest: '', migration: '' },
    packages: [
      {
        kind: 'plugin',
        id: 'demo',
        fromVersion: '1.0.0',
        toVersion: '1.1.0',
        revision: 'a'.repeat(64),
        addsPermissions: false,
        reversible: true,
      },
    ],
    planDigestInput: { kernelVersion: '0.2.0', packages: [], frontendAbi: '1.0.0', schemaRange: '*' },
    ...overrides,
  };
}

const NOON = new Date('2026-06-01T12:00:00');

describe('decideAutoUpdate', () => {
  it('does not auto-submit when automatic updates are off (default)', () => {
    const decision = decideAutoUpdate({
      policy: normalizeUpdatePolicy({}),
      plan: plan(),
      requiresAuthorization: false,
      includesKernel: false,
      now: NOON,
    });
    expect(decision).toMatchObject({ submit: false, reason: 'auto-disabled' });
  });

  it('submits when enabled, in-window, no authorization needed', () => {
    const decision = decideAutoUpdate({
      policy: normalizeUpdatePolicy({ autoUpdate: true }),
      plan: plan(),
      requiresAuthorization: false,
      includesKernel: false,
      now: NOON,
    });
    expect(decision).toMatchObject({ submit: true, reason: 'eligible' });
  });

  it('respects the maintenance window', () => {
    const decision = decideAutoUpdate({
      policy: normalizeUpdatePolicy({ autoUpdate: true, maintenanceWindow: { startHour: 2, endHour: 4 } }),
      plan: plan(),
      requiresAuthorization: false,
      includesKernel: false,
      now: NOON,
    });
    expect(decision).toMatchObject({ submit: false, reason: 'outside-window' });
  });

  it('never auto-applies a plan that adds permissions or irreversible migrations', () => {
    const decision = decideAutoUpdate({
      policy: normalizeUpdatePolicy({ autoUpdate: true }),
      plan: plan(),
      requiresAuthorization: true,
      includesKernel: false,
      now: NOON,
    });
    expect(decision).toMatchObject({ submit: false, reason: 'requires-authorization' });
  });

  it('requires autoUpdateKernel for a plan that includes the kernel', () => {
    const blocked = decideAutoUpdate({
      policy: normalizeUpdatePolicy({ autoUpdate: true }),
      plan: plan(),
      requiresAuthorization: false,
      includesKernel: true,
      now: NOON,
    });
    expect(blocked).toMatchObject({ submit: false, reason: 'kernel-not-auto' });
    const allowed = decideAutoUpdate({
      policy: normalizeUpdatePolicy({ autoUpdate: true, autoUpdateKernel: true }),
      plan: plan(),
      requiresAuthorization: false,
      includesKernel: true,
      now: NOON,
    });
    expect(allowed).toMatchObject({ submit: true });
  });

  it('treats an excluded-only plan as no-change', () => {
    const decision = decideAutoUpdate({
      policy: normalizeUpdatePolicy({ autoUpdate: true, excluded: ['plugin/demo'] }),
      plan: plan(),
      requiresAuthorization: false,
      includesKernel: false,
      now: NOON,
    });
    expect(decision).toMatchObject({ submit: false, reason: 'no-change' });
  });

  it('treats a pinned-only plan as no-change', () => {
    const decision = decideAutoUpdate({
      policy: normalizeUpdatePolicy({ autoUpdate: true, pinned: { 'plugin/demo': '1.0.0' } }),
      plan: plan(),
      requiresAuthorization: false,
      includesKernel: false,
      now: NOON,
    });
    expect(decision).toMatchObject({ submit: false, reason: 'no-change' });
  });
});
