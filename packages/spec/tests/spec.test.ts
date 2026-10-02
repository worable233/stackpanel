import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  API_VERSION,
  KERNEL_API_VERSION,
  KERNEL_VERSION,
  OPEN_API_NAMESPACE,
  kernelApiVersionRange,
} from '../src/version.js';
import {
  buildSnapshot,
  diffContracts,
  hashOperations,
  normalizeSpec,
  scopeOperations,
  snapshotFromOperations,
} from '../src/contract.js';
import { applyCapabilityOperations, capabilityPaths, toOpenApiOperation } from '../src/openapi.js';

/**
 * 契约包自测：版本单一来源、OpenAPI 投影与兼容性判定。CI 门禁只在这些规则
 * 可信时才有价值，所以这里正面钉死每条判定。
 */
describe('contract version', () => {
  it('exposes a single kernel API version and matching range', () => {
    expect(KERNEL_API_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(kernelApiVersionRange()).toBe(`>=${KERNEL_API_VERSION}`);
    expect(API_VERSION).toBe('v1');
    expect(OPEN_API_NAMESPACE).toBe('/api/v1');
  });

  it('exposes a kernel product version independent from the contract version', () => {
    expect(KERNEL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('keeps the kernel packages in lock-step with the product version', () => {
    // 产品版本唯一来源：root + apps + 内部 packages 的 package.json version。
    const here = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(here, '..', '..', '..');
    for (const pkgPath of [
      'package.json',
      'apps/api/package.json',
      'apps/web/package.json',
      'packages/db/package.json',
      'packages/ui/package.json',
      'packages/net-guard/package.json',
    ]) {
      const pkg = JSON.parse(readFileSync(path.join(repoRoot, pkgPath), 'utf8')) as {
        version?: string;
      };
      expect(pkg.version).toBe(KERNEL_VERSION);
    }
  });

  it('keeps the published ecosystem package versions in lock-step with the contract', () => {
    // 发版联动（D13）：SDK / 契约包 / MCP 版本必须等于 KERNEL_API_VERSION，
    // 否则「已发布包版本」与「内核契约版本」会漂移。
    const here = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(here, '..', '..', '..');
    for (const pkgPath of [
      'packages/sdk/package.json',
      'packages/spec/package.json',
      'packages/mcp/package.json',
    ]) {
      const pkg = JSON.parse(readFileSync(path.join(repoRoot, pkgPath), 'utf8')) as {
        version?: string;
        private?: boolean;
      };
      expect(pkg.version).toBe(KERNEL_API_VERSION);
      expect(pkg.private).not.toBe(true);
    }
  });
});

describe('openapi projection', () => {
  it('marks scoped operations as authenticated and mutating ones as idempotent', () => {
    const op = toOpenApiOperation({
      method: 'POST',
      path: '/api/v1/widgets',
      summary: 'Create a widget',
      scope: 'widget:write',
      mutating: true,
    });
    expect(op.tags).toEqual(['open-api']);
    expect(op.security).toEqual([{ bearerAuth: [] }]);
    expect(op.parameters).toEqual([
      { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' } },
    ]);
    expect(op.responses).toEqual({
      '200': { description: 'OK' },
      '401': { description: 'Unauthorized' },
      '403': { description: 'Forbidden' },
    });
  });

  it('leaves identity-only operations unauthenticated', () => {
    const op = toOpenApiOperation({
      method: 'GET',
      path: '/api/v1/platform',
      summary: 'Platform info',
      scope: null,
      mutating: false,
    });
    expect(op.security).toBeUndefined();
    expect(op.parameters).toBeUndefined();
  });

  it('merges capabilities into a paths map in place', () => {
    const paths: Record<string, unknown> = {};
    applyCapabilityOperations(paths, [
      {
        method: 'GET',
        path: '/api/v1/widgets',
        summary: 'List widgets',
        scope: 'widget:read',
        mutating: false,
      },
    ]);
    expect(paths['/api/v1/widgets']).toBeDefined();
    const built = capabilityPaths([
      { method: 'GET', path: '/x', summary: 'x', scope: null, mutating: false },
    ]);
    expect(built.paths['/x']?.get).toBeDefined();
  });
});

describe('contract compatibility', () => {
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

  it('normalises spec into a stable operation projection', () => {
    const ops = normalizeSpec({
      paths: {
        '/api/v1/widgets': {
          get: { responses: { 200: {}, 401: {} } },
          post: {
            security: [{ bearerAuth: {} }],
            parameters: [
              { name: 'Idempotency-Key', in: 'header', required: true },
              { name: 'q', in: 'query', required: false },
            ],
            requestBody: {},
            responses: { 200: {} },
          },
        },
      },
    });
    expect(ops['GET /api/v1/widgets']).toEqual({
      security: [],
      requiredParameters: [],
      hasRequestBody: false,
      responseCodes: ['200', '401'],
    });
    expect(ops['POST /api/v1/widgets']?.requiredParameters).toEqual(['header:Idempotency-Key']);
    expect(ops['POST /api/v1/widgets']?.security).toEqual(['bearerAuth']);
  });

  it('hashes canonically regardless of key order', () => {
    const a = hashOperations({ 'GET /a': getWidgets, 'GET /b': getWidgets });
    const b = hashOperations({ 'GET /b': getWidgets, 'GET /a': getWidgets });
    expect(a).toBe(b);
  });

  it('scopes the projection to an explicit key set', () => {
    const ops = normalizeSpec(
      capabilityPaths([
        { method: 'GET', path: '/a', summary: 'a', scope: null, mutating: false },
        { method: 'GET', path: '/b', summary: 'b', scope: null, mutating: false },
      ]),
    );
    expect(Object.keys(scopeOperations(ops, ['GET /a']))).toEqual(['GET /a']);
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
    const current = {
      ...base.operations,
      'GET /api/v1/widgets': { ...getWidgets, security: ['bearerAuth'] },
    };
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
    const current = {
      ...base.operations,
      'POST /api/v1/widgets': { ...postWidgets, responseCodes: ['200'] },
    };
    expect(diffContracts(base, current).breaking.map((b) => b.kind)).toContain('response_removed');
  });

  it('allows relaxing auth', () => {
    const current = {
      ...base.operations,
      'POST /api/v1/widgets': { ...postWidgets, requiredParameters: [] },
    };
    expect(diffContracts(base, current).breaking).toEqual([]);
  });

  it('builds a snapshot from a raw spec', () => {
    const snapshot = buildSnapshot(
      capabilityPaths([{ method: 'GET', path: '/x', summary: 'x', scope: null, mutating: false }]),
      'v1',
    );
    expect(Object.keys(snapshot.operations)).toEqual(['GET /x']);
    expect(snapshot.formatVersion).toBe(1);
  });
});
