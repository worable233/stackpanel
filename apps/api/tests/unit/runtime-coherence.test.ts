import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { closeRedis, getRedis, pingRedis } from '@stackpanel/db';
import type { PluginDefinition } from '@stackpanel/sdk';
import { RuntimeCoherence } from '../../src/runtime/coherence.ts';
import type { PluginRuntime } from '../../src/plugins/runtime.ts';

/**
 * Cross-replica runtime coherence (S8 / ADR-0017 §4).
 *
 * Two coherence instances stand in for two replicas sharing one Redis. A change
 * broadcast by one must converge the other's plugin runtime to the database's
 * authoritative enabled state, without a restart. The reload entry point must be
 * idempotent (racing/repeated messages cannot accumulate registrations).
 */
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const redis = await (async () => {
  try {
    const client = await getRedis(REDIS_URL);
    return (await pingRedis()) ? client : null;
  } catch {
    return null;
  }
})();

afterAll(async () => {
  await closeRedis();
});

/** Minimal PluginRuntime double recording the lifecycle calls reload performs. */
class StubRuntime {
  readonly events: string[] = [];
  private readonly ids = new Set<string>();
  private readonly active = new Set<string>();

  has(id: string): boolean {
    return this.ids.has(id);
  }

  isActive(id: string): boolean {
    return this.active.has(id);
  }

  async unregister(id: string): Promise<void> {
    this.events.push(`unregister:${id}`);
    this.ids.delete(id);
    this.active.delete(id);
  }

  async register(definition: PluginDefinition): Promise<void> {
    this.events.push(`register:${definition.manifest.id}`);
    this.ids.add(definition.manifest.id);
  }

  async activate(id: string): Promise<void> {
    this.events.push(`activate:${id}`);
    this.ids.add(id);
    this.active.add(id);
  }
}

function stubDefinition(id: string): PluginDefinition {
  return { manifest: { id, name: id, version: '1.0.0' } } as PluginDefinition;
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

describe.skipIf(!redis)('RuntimeCoherence (redis)', () => {
  const logger = { warn: () => undefined, info: () => undefined };

  function makeInstance(enabled: Set<string>, channel?: string) {
    const runtime = new StubRuntime();
    const coherence = new RuntimeCoherence({
      runtime: runtime as unknown as PluginRuntime,
      redis,
      loadDefinition: async (id) => stubDefinition(id),
      isEnabled: async (id) => enabled.has(id),
      // Unique channel per instance so parallel suites never interfere.
      channel: channel ?? `sp:runtime:test:${randomUUID().slice(0, 8)}`,
      logger,
    });
    return { runtime, coherence };
  }

  it('converges another replica onto DB enabled state without a restart', async () => {
    const enabled = new Set(['demo']);
    const channel = `sp:runtime:test:${randomUUID().slice(0, 8)}`;
    const a = makeInstance(enabled, channel);
    const b = makeInstance(enabled, channel);
    await a.coherence.start();
    await b.coherence.start();
    try {
      expect(b.runtime.has('demo')).toBe(false);
      await a.coherence.publish({ kind: 'plugin', id: 'demo', action: 'activate' });
      await waitFor(() => b.runtime.isActive('demo'));
      expect(b.runtime.events).toContain('register:demo');
      expect(b.runtime.events).toContain('activate:demo');
    } finally {
      await a.coherence.stop();
      await b.coherence.stop();
    }
  });

  it('leaves a plugin registered but inactive when the DB says disabled', async () => {
    const channel = `sp:runtime:test:${randomUUID().slice(0, 8)}`;
    const a = makeInstance(new Set(), channel);
    const b = makeInstance(new Set(), channel);
    await a.coherence.start();
    await b.coherence.start();
    try {
      await a.coherence.publish({ kind: 'plugin', id: 'demo', action: 'deactivate' });
      await waitFor(() => b.runtime.has('demo'));
      expect(b.runtime.isActive('demo')).toBe(false);
    } finally {
      await a.coherence.stop();
      await b.coherence.stop();
    }
  });

  it('reload is idempotent and never double-registers', async () => {
    const enabled = new Set(['demo']);
    const { runtime, coherence } = makeInstance(enabled);
    await coherence.reload('demo');
    await coherence.reload('demo');
    expect(runtime.events).toEqual([
      'register:demo',
      'activate:demo',
      'unregister:demo',
      'register:demo',
      'activate:demo',
    ]);
    expect(runtime.isActive('demo')).toBe(true);
  });

  it('ignores its own broadcast (the caller already applied it)', async () => {
    const enabled = new Set(['demo']);
    const { runtime, coherence } = makeInstance(enabled);
    await coherence.start();
    try {
      await coherence.publish({ kind: 'plugin', id: 'demo', action: 'activate' });
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(runtime.has('demo')).toBe(false);
    } finally {
      await coherence.stop();
    }
  });

  it('is a no-op without Redis (dev fallback)', async () => {
    const runtime = new StubRuntime();
    const coherence = new RuntimeCoherence({
      runtime: runtime as unknown as PluginRuntime,
      redis: null,
      loadDefinition: async (id) => stubDefinition(id),
      isEnabled: async () => true,
      logger,
    });
    await coherence.start();
    await coherence.publish({ kind: 'plugin', id: 'demo', action: 'activate' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(runtime.events).toEqual([]);
  });
});
