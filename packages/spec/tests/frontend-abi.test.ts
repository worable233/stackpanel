import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HOST_FRONTEND_ABI,
  HOST_FRONTEND_ABI_SLOTS,
  satisfiesRange,
  validateFrontendExternals,
} from '../src/frontend-abi.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

function installedVersion(pkg: string): string | null {
  try {
    const p = path.join(repoRoot, 'node_modules', pkg, 'package.json');
    return JSON.parse(readFileSync(p, 'utf8')).version as string;
  } catch {
    return null;
  }
}

describe('host frontend ABI table', () => {
  it('lists the frozen slots and every slot has a declared host version', () => {
    expect(HOST_FRONTEND_ABI_SLOTS).toContain('react');
    expect(HOST_FRONTEND_ABI_SLOTS).toContain('@stackpanel/ui');
    expect(HOST_FRONTEND_ABI_SLOTS).not.toContain('zod');
    for (const slot of HOST_FRONTEND_ABI_SLOTS) {
      expect(HOST_FRONTEND_ABI[slot]).toBeTruthy();
    }
  });

  it('keeps react/react-dom/jsx-runtime pinned to the same version', () => {
    expect(HOST_FRONTEND_ABI['react']).toBe(installedVersion('react') ?? HOST_FRONTEND_ABI['react']);
    expect(HOST_FRONTEND_ABI['react-dom']).toBe(HOST_FRONTEND_ABI['react']);
    expect(HOST_FRONTEND_ABI['react/jsx-runtime']).toBe(HOST_FRONTEND_ABI['react']);
  });

  it('matches the installed next version (drift guard)', () => {
    const next = installedVersion('next');
    // next may live under apps/web/node_modules in the monorepo; skip when the
    // root copy is absent rather than fail on layout.
    if (next) {
      expect(HOST_FRONTEND_ABI['next/link']).toBe(next);
      expect(HOST_FRONTEND_ABI['next/form']).toBe(next);
      expect(HOST_FRONTEND_ABI['next/navigation']).toBe(next);
    }
  });
});

describe('validateFrontendExternals', () => {
  it('accepts a range the host version satisfies', () => {
    expect(validateFrontendExternals({ react: '^19.0.0' })).toEqual([]);
    expect(validateFrontendExternals({ '@stackpanel/ui': '>=0.2 <0.3' })).toEqual([]);
    expect(validateFrontendExternals({ 'react/jsx-runtime': '19.2.x' })).toEqual([]);
  });

  it('rejects a host version outside the declared range (unsatisfied → 409)', () => {
    const errors = validateFrontendExternals({ react: '^18.0.0' });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.reason).toBe('unsatisfied');
  });

  it('rejects an unknown slot (protocol error → 422)', () => {
    const errors = validateFrontendExternals({ 'not-a-slot': '^1.0.0' });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.reason).toBe('unknown-slot');
  });
});

describe('satisfiesRange (controlled subset)', () => {
  it('handles ^, ~, comparators and space-joined conjunctions', () => {
    expect(satisfiesRange('19.2.4', '^19.0.0')).toBe(true);
    expect(satisfiesRange('20.0.0', '^19.0.0')).toBe(false);
    expect(satisfiesRange('19.2.9', '~19.2.0')).toBe(true);
    expect(satisfiesRange('19.3.0', '~19.2.0')).toBe(false);
    expect(satisfiesRange('16.3.8', '>=16 <17')).toBe(true);
    expect(satisfiesRange('17.0.0', '>=16 <17')).toBe(false);
    expect(satisfiesRange('19.2.4', '19.2.4')).toBe(true);
  });
});
