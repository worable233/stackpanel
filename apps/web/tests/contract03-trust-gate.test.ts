import { afterEach, describe, expect, it } from 'vitest';
import {
  candidateAdmitsServerExecution,
  serverExecutionGateEnabled,
  type FrontendCandidate,
} from '@/lib/slots';

/**
 * Contract 03 §3.1: the web-process server-execution gate.
 *
 * Default ON (ADR-0024 as merged): only candidates with the kernel's
 * `serverExecution === 'allowed'` (built-in plugins, or operator allowlist)
 * execute; themes ship with the image and are always admitted; an absent
 * decision (older API) is fail-closed. `STACKPANEL_FRONTEND_TRUST_GATE=0` opts
 * back into the legacy "every package may execute" behaviour.
 */

const ENV = 'STACKPANEL_FRONTEND_TRUST_GATE';

function plugin(serverExecution?: 'allowed' | 'declarative'): FrontendCandidate {
  return {
    kind: 'plugins',
    id: 'third-party',
    manifest: { version: '1.0.0', revision: 'r1', entry: 'frontend/dist/index.js', files: [] } as unknown as FrontendCandidate['manifest'],
    ...(serverExecution ? { serverExecution } : {}),
  };
}

const theme: FrontendCandidate = {
  kind: 'themes',
  id: 'default',
  manifest: { version: '1.0.0', revision: 'r1', entry: 'frontend/dist/index.js', files: [] } as unknown as FrontendCandidate['manifest'],
};

afterEach(() => {
  delete process.env[ENV];
});

describe('server execution gate (contract 03 §3.1)', () => {
  it('is ON by default, denying a declarative plugin', () => {
    expect(serverExecutionGateEnabled()).toBe(true);
    expect(candidateAdmitsServerExecution(plugin('declarative'))).toBe(false);
    expect(candidateAdmitsServerExecution(plugin('allowed'))).toBe(true);
  });

  it('admits built-in packages (kernel reports them as allowed)', () => {
    expect(candidateAdmitsServerExecution(plugin('allowed'))).toBe(true);
  });

  it('fail-closed: an absent decision is denied while the gate is ON', () => {
    expect(candidateAdmitsServerExecution(plugin())).toBe(false);
  });

  it('always admits themes (they ship with the image)', () => {
    expect(candidateAdmitsServerExecution(theme)).toBe(true);
  });

  it('only the exact value "0" disables the gate', () => {
    for (const value of ['1', 'true', 'yes', '']) {
      process.env[ENV] = value;
      expect(serverExecutionGateEnabled()).toBe(true);
    }
    process.env[ENV] = '0';
    expect(serverExecutionGateEnabled()).toBe(false);
    // Legacy mode: even a declarative plugin is admitted.
    expect(candidateAdmitsServerExecution(plugin('declarative'))).toBe(true);
  });
});
