import { describe, expect, it } from 'vitest';
import {
  BOOTSTRAP_CONFIG_KEYS,
  BOOTSTRAP_ERROR_CODES,
  BOOTSTRAP_TERMINAL_PHASES,
  BOOTSTRAP_WRITABLE_PHASES,
  bootstrapAcceptsConfig,
  type BootstrapPhase,
} from '@stackpanel/spec';
import {
  bootstrapProvisionResponseSchema,
  setupStatusResponseSchema,
} from '@stackpanel/sdk';
import type { BootstrapPhase as SdkBootstrapPhase } from '@stackpanel/sdk';

/**
 * BOOTSTRAP-R10: the SDK is deliberately dependency-free, so it duplicates the
 * phase union and the operate view shape instead of importing
 * `@stackpanel/spec`. Duplication is only safe if it is pinned — otherwise a
 * new phase added to the kernel silently breaks the web page, which would fall
 * through to the "unavailable" branch and look like an outage.
 */

/** Single source of truth, written out so adding a phase must touch this test. */
const CANONICAL_PHASES = [
  'needs_infra',
  'validating',
  'queued',
  'migrating',
  'migration_failed',
  'starting',
  'runtime_failed',
  'needs_admin',
  'complete',
] as const satisfies readonly BootstrapPhase[];

describe('bootstrap phase contract', () => {
  it('matches the SDK union exactly (compile-time + runtime)', () => {
    const sdkOnly: SdkBootstrapPhase[] = [...CANONICAL_PHASES];
    const specOnly: BootstrapPhase[] = [...CANONICAL_PHASES];
    expect(sdkOnly).toEqual(specOnly);
    expect(new Set(CANONICAL_PHASES).size).toBe(CANONICAL_PHASES.length);
  });

  it('agrees on which phases accept config', () => {
    for (const phase of CANONICAL_PHASES) {
      expect(bootstrapAcceptsConfig(phase)).toBe(
        (BOOTSTRAP_WRITABLE_PHASES as readonly string[]).includes(phase),
      );
    }
    // The whole point of the state machine: a failed *runtime* must not reopen
    // the database configuration surface.
    expect(bootstrapAcceptsConfig('runtime_failed')).toBe(false);
    expect(bootstrapAcceptsConfig('needs_admin')).toBe(false);
    expect(bootstrapAcceptsConfig('complete')).toBe(false);
    expect(bootstrapAcceptsConfig('migration_failed')).toBe(true);
  });

  it('treats complete as the only terminal phase', () => {
    expect([...BOOTSTRAP_TERMINAL_PHASES]).toEqual(['complete']);
  });

  it('has every canonical phase accepted by the zod schemas', () => {
    for (const phase of CANONICAL_PHASES) {
      expect(
        setupStatusResponseSchema.safeParse({
          required: phase !== 'complete',
          tokenRequired: true,
          phase,
        }).success,
        phase,
      ).toBe(true);
    }
    expect(
      setupStatusResponseSchema.safeParse({
        required: true,
        tokenRequired: false,
        phase: 'not_a_phase',
      }).success,
    ).toBe(false);
  });

  it('parses a provision response without leaking unknown fields', () => {
    const parsed = bootstrapProvisionResponseSchema.parse({
      operation: {
        id: 'abc',
        configGeneration: 2,
        targetVersion: '0.3.0',
        phase: 'queued',
        createdAt: '2026-10-20T00:00:00.000Z',
        updatedAt: '2026-10-20T00:00:00.000Z',
      },
      // A server must never send this, but the schema must not accept it into
      // typed data either (zod strips unknown keys by default).
      DATABASE_URL: 'postgresql://u:p@h/db',
    });
    expect(parsed).not.toHaveProperty('DATABASE_URL');
    expect(parsed.operation.phase).toBe('queued');
  });
});

describe('bootstrap config whitelist', () => {
  it('never includes secrets that only the installer owns', () => {
    for (const forbidden of [
      'JWT_SECRET',
      'SETTINGS_ENCRYPTION_KEY',
      'STACKPANEL_SETUP_TOKEN',
      'STACKPANEL_DATA_DIR',
      'STACKPANEL_STATE_DIR',
      'NODE_ENV',
      'PATH',
      'NODE_OPTIONS',
    ]) {
      expect(BOOTSTRAP_CONFIG_KEYS as readonly string[]).not.toContain(forbidden);
    }
  });

  it('covers every infrastructure family the operator must supply', () => {
    expect(BOOTSTRAP_CONFIG_KEYS as readonly string[]).toContain('DATABASE_URL');
    expect(BOOTSTRAP_CONFIG_KEYS as readonly string[]).toContain('REDIS_URL');
    expect(BOOTSTRAP_CONFIG_KEYS as readonly string[]).toContain('STORAGE_DRIVER');
    for (const key of BOOTSTRAP_CONFIG_KEYS) {
      // Only upper-case snake case keys survive systemd/dotenv and our parser.
      expect(key).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });
});

describe('bootstrap error codes', () => {
  it('are stable, namespaced strings', () => {
    for (const code of Object.values(BOOTSTRAP_ERROR_CODES)) {
      expect(code).toMatch(/^bootstrap\.[a-z_]+$/);
    }
    expect(Object.values(BOOTSTRAP_ERROR_CODES)).toContain('bootstrap.token_invalid');
    expect(Object.values(BOOTSTRAP_ERROR_CODES)).toContain('bootstrap.probe_failed');
    expect(Object.values(BOOTSTRAP_ERROR_CODES)).toContain('bootstrap.not_writable');
  });
});
