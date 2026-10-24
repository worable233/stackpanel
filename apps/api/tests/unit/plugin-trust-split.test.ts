import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveExecution,
  resolveFrontendExecutions,
  resolveRemovable,
} from '../../src/lib/plugins.ts';

/**
 * Contract 03 §3.1 / ADR-0024 — the three decisions that used to be one bit.
 *
 * `builtin` means exactly one thing: "this package ships with the kernel
 * image". It must not imply a backend execution mode, a web-process execution
 * grant, or uninstall immunity. Each of those is resolved by its own function
 * with its own inputs, so that:
 *
 *   - a built-in can run isolated,
 *   - an operator can admit a third-party package to the web process,
 *   - an operator can revoke a built-in's web-process grant,
 *   - uninstall policy can change without touching any execution decision.
 */

const ENV_KEYS = [
  'NODE_ENV',
  'STACKPANEL_FRONTEND_SERVER_EXEC',
  'STACKPANEL_FRONTEND_SERVER_EXEC_DENY',
] as const;

const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('resolveExecution: provenance is a default, not a privilege', () => {
  it('runs a built-in in-process by default', () => {
    delete process.env['NODE_ENV'];
    expect(resolveExecution({ builtin: true })).toBe('trusted');
  });

  it('isolates a third-party package in production', () => {
    process.env['NODE_ENV'] = 'production';
    expect(resolveExecution({})).toBe('isolated');
    expect(resolveExecution({ builtin: false })).toBe('isolated');
  });

  it('keeps development fast by trusting an unmarked package', () => {
    process.env['NODE_ENV'] = 'development';
    expect(resolveExecution({})).toBe('trusted');
  });

  it('honours an explicit mode even for a built-in', () => {
    // This is what makes "run the shipped packages isolated" testable at all:
    // before, builtin short-circuited to trusted and the isolated path was
    // unreachable for anything the kernel ships.
    process.env['NODE_ENV'] = 'production';
    expect(resolveExecution({ builtin: true, execution: 'isolated' })).toBe('isolated');
    expect(resolveExecution({ execution: 'trusted' })).toBe('trusted');
  });

  it('lets an explicit mode override the development default too', () => {
    process.env['NODE_ENV'] = 'development';
    expect(resolveExecution({ execution: 'isolated' })).toBe('isolated');
  });
});

describe('resolveRemovable: uninstall policy is independent of provenance', () => {
  it('defaults to removable for an operator-installed package', () => {
    expect(resolveRemovable({})).toBe(true);
    expect(resolveRemovable({ builtin: false })).toBe(true);
  });

  it('defaults to pinned for a package that ships with the kernel', () => {
    expect(resolveRemovable({ builtin: true })).toBe(false);
  });

  it('honours an explicit kernel decision over the provenance default', () => {
    expect(resolveRemovable({ builtin: true, removable: true })).toBe(true);
    expect(resolveRemovable({ builtin: false, removable: false })).toBe(false);
  });
});

describe('resolveFrontendExecutions: web-process admission is independent', () => {
  it('admits a built-in by default', () => {
    delete process.env['STACKPANEL_FRONTEND_SERVER_EXEC'];
    delete process.env['STACKPANEL_FRONTEND_SERVER_EXEC_DENY'];
    expect(resolveFrontendExecutions('store', true)).toBe('server');
  });

  it('denies a third-party package by default', () => {
    expect(resolveFrontendExecutions('third-party', false)).toBe('declarative');
  });

  it('admits a third-party package the operator lists', () => {
    process.env['STACKPANEL_FRONTEND_SERVER_EXEC'] = 'a, third-party ,b';
    expect(resolveFrontendExecutions('third-party', false)).toBe('server');
    expect(resolveFrontendExecutions('unlisted', false)).toBe('declarative');
  });

  it('revokes a built-in that the operator denies, while it stays built-in', () => {
    process.env['STACKPANEL_FRONTEND_SERVER_EXEC_DENY'] = 'store';
    expect(resolveFrontendExecutions('store', true)).toBe('declarative');
  });

  it('lets deny win over the allowlist', () => {
    process.env['STACKPANEL_FRONTEND_SERVER_EXEC'] = 'x';
    process.env['STACKPANEL_FRONTEND_SERVER_EXEC_DENY'] = 'x';
    expect(resolveFrontendExecutions('x', false)).toBe('declarative');
  });

  it('does not treat an empty variable as an entry', () => {
    process.env['STACKPANEL_FRONTEND_SERVER_EXEC'] = '';
    expect(resolveFrontendExecutions('', false)).toBe('declarative');
  });
});
