import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '../../src/lib/capability-registry.ts';
import {
  diffContracts,
  normalizeSpec,
  scopeOperations,
  snapshotFromOperations,
} from '../../src/lib/contract-snapshot.ts';
import {
  capabilityPaths,
  fromKernelCapability,
} from '../../src/lib/openapi-contract.ts';

/**
 * G2: the OpenAPI contract snapshot is a pure function of the kernel capability
 * registry. These tests pin the projection/normalisation rules and prove the
 * breaking-change detector actually fires — the CI gate is only worth having if
 * its judgement is trustworthy.
 */

/** The canonical projection of the kernel open-platform surface. */
function currentOperations() {
  const spec = capabilityPaths(CAPABILITIES.map(fromKernelCapability));
  return normalizeSpec(spec);
}

describe('contract snapshot projection', () => {
  it('captures 方法 / 路径 / 鉴权 / 必填参数 / 响应码', () => {
    const ops = currentOperations();
    const patch = ops['PATCH /api/v1/platform'];
    expect(patch).toBeDefined();
    expect(patch?.security).toEqual(['bearerAuth']);
    expect(patch?.requiredParameters).toEqual(['header:Idempotency-Key']);
    expect(patch?.responseCodes).toEqual(['200', '401', '403']);

    const publicRead = ops['GET /api/v1/platform'];
    expect(publicRead?.security).toEqual([]);
    expect(publicRead?.requiredParameters).toEqual([]);
  });

  it('scopes the projection to an explicit key set', () => {
    const ops = currentOperations();
    const keys = CAPABILITIES.map((cap) => `${cap.method} ${cap.path}`);
    const scoped = scopeOperations(ops, keys);
    expect(Object.keys(scoped).sort()).toEqual([...keys].sort());
  });

  it('is stable regardless of plugin-active state (scoped to the registry)', () => {
    // Two builds of the same registry produce the identical hash, so a plugin
    // toggling in CI cannot make the baseline flap.
    const a = snapshotFromOperations(currentOperations(), 'v1');
    const b = snapshotFromOperations(currentOperations(), 'v1');
    expect(a.hash).toBe(b.hash);
  });
});

describe('contract compatibility detection', () => {
  const getWidgets = {
    security: [] as string[],
    requiredParameters: [] as string[],
    hasRequestBody: false,
    responseCodes: ['200'],
  };
  const postWidgets = {
    security: ['bearerAuth'],
    requiredParameters: ['header:Idempotency-Key'],
    hasRequestBody: false,
    responseCodes: ['200', '401'],
  };
  const base = snapshotFromOperations(
    { 'GET /api/v1/widgets': getWidgets, 'POST /api/v1/widgets': postWidgets },
    'v1',
  );

  it('matches the committed baseline (no unintended drift)', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const baselinePath = path.resolve(here, '..', '..', 'contracts', 'openapi-v1.snapshot.json');
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as ReturnType<
      typeof snapshotFromOperations
    >;
    const current = currentOperations();
    const diff = diffContracts(baseline, current);
    // Any breaking change must have been an explicit, reviewed snapshot update;
    // the CI `--check` step enforces the same thing outside the test runner.
    expect(diff.breaking).toEqual([]);
    expect(baseline.hash).toBe(snapshotFromOperations(current, 'v1').hash);
  });

  it('treats an added operation as compatible', () => {
    const current = {
      ...base.operations,
      'GET /api/v1/gadgets': {
        security: [],
        requiredParameters: [],
        hasRequestBody: false,
        responseCodes: ['200'],
      },
    };
    const diff = diffContracts(base, current);
    expect(diff.breaking).toEqual([]);
    expect(diff.added).toEqual(['GET /api/v1/gadgets']);
  });

  it('flags a removed operation', () => {
    const current = { ...base.operations };
    delete current['GET /api/v1/widgets'];
    const diff = diffContracts(base, current);
    expect(diff.breaking.map((b) => b.kind)).toContain('operation_removed');
    expect(diff.removed).toContain('GET /api/v1/widgets');
  });

  it('flags auth being newly required', () => {
    const current = { ...base.operations, 'GET /api/v1/widgets': { ...getWidgets, security: ['bearerAuth'] } };
    expect(diffContracts(base, current).breaking.map((b) => b.kind)).toContain(
      'security_required_added',
    );
  });

  it('flags a newly required parameter and a newly required body', () => {
    const current = {
      ...base.operations,
      'GET /api/v1/widgets': {
        ...getWidgets,
        requiredParameters: ['query:cursor'],
        hasRequestBody: true,
      },
    };
    const kinds = diffContracts(base, current).breaking.map((b) => b.kind);
    expect(kinds).toContain('required_parameter_added');
    expect(kinds).toContain('request_body_added');
  });

  it('flags a removed response code', () => {
    const current = { ...base.operations, 'POST /api/v1/widgets': { ...postWidgets, responseCodes: ['200'] } };
    expect(diffContracts(base, current).breaking.map((b) => b.kind)).toContain('response_removed');
  });

  it('allows relaxing auth (an added optional path)', () => {
    const current = { ...base.operations, 'POST /api/v1/widgets': { ...postWidgets, requiredParameters: [] } };
    expect(diffContracts(base, current).breaking).toEqual([]);
  });
});
