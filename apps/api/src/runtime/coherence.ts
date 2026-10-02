/**
 * Runtime coherence across replicas (S8 / ADR-0017 §4).
 *
 * The plugin runtime and the theme registry are in-memory: activating a plugin
 * or switching a theme on replica A only changes A. Without coordination the
 * other replicas keep serving the old state until they restart.
 *
 * This module closes that gap with a Redis Pub/Sub invalidation broadcast. The
 * replica that performs a change applies it locally first (the normal route
 * path), then publishes a small message. Every other replica receives it and
 * reloads the affected runtime cache through one idempotent entry point,
 * {@link RuntimeCoherence.reload}. There is no second source of truth: the
 * database (plugin `enabled`) and the on-disk package remain authoritative.
 *
 * Channel and key namespace reuse `REDIS_KEY_PREFIX.runtime` (`sp:runtime:`);
 * no new prefix is introduced (see `packages/sdk/src/key-prefixes.ts`).
 *
 * Development without Redis degrades to a no-op: single-replica behaviour is
 * unchanged, multi-replica consistency requires a replica restart (documented).
 */
import { randomUUID } from 'node:crypto';
import type { PluginDefinition } from '@stackpanel/sdk';
import { REDIS_KEY_PREFIX } from '@stackpanel/sdk';
import type { RedisClient } from '@stackpanel/db';
import type { PluginRuntime } from '../plugins/runtime.ts';

export type RuntimeChangeAction = 'activate' | 'deactivate' | 'reload' | 'remove';

/** A runtime cache invalidation broadcast across replicas. */
export interface RuntimeChange {
  /** Which runtime cache changed. */
  kind: 'plugin' | 'theme';
  /** Plugin id, or theme id for `kind: 'theme'`. */
  id: string;
  action: RuntimeChangeAction;
}

export interface RuntimeCoherenceOptions {
  runtime: PluginRuntime;
  /** Shared Redis client; null disables cross-replica delivery (dev fallback). */
  redis: RedisClient | null;
  /** Load a plugin definition from its installed package on disk. */
  loadDefinition: (id: string) => Promise<PluginDefinition>;
  /** Whether the plugin is enabled in the database (authoritative). */
  isEnabled: (id: string) => Promise<boolean>;
  /** Invoked when a theme change is broadcast (defaults to a no-op). */
  onThemeReload?: () => void | Promise<void>;
  logger?: { warn: (m: string) => void; info?: (m: string) => void };
  /** Override the Pub/Sub channel (tests). Defaults to the runtime namespace. */
  channel?: string;
}

interface RuntimeEnvelope extends RuntimeChange {
  origin: string;
}

/** Default Pub/Sub channel for runtime invalidation. */
export function runtimeInvalidateChannel(): string {
  return `${REDIS_KEY_PREFIX.runtime}invalidate`;
}

/** Redis Pub/Sub driven runtime invalidation. */
export class RuntimeCoherence {
  private subscriber: RedisClient | null = null;
  private readonly origin = randomUUID().slice(0, 8);
  /** Serializes reloads per plugin id so racing messages cannot interleave. */
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly options: RuntimeCoherenceOptions) {}

  private channel(): string {
    return this.options.channel ?? runtimeInvalidateChannel();
  }

  private log(message: string): void {
    this.options.logger?.info?.(`[runtime] ${message}`);
  }

  /**
   * Subscribe to invalidation broadcasts. Idempotent; a no-op without Redis.
   * Called explicitly by the API and worker entrypoints (not by `buildApp`, so
   * hermetic tests never open a subscriber).
   */
  async start(): Promise<void> {
    const redis = this.options.redis;
    if (!redis || this.subscriber) return;
    this.subscriber = redis.duplicate();
    await this.subscriber.subscribe(this.channel());
    this.subscriber.on('message', (_channel: string, message: string) => {
      const envelope = safeParse(message);
      if (!envelope) return;
      // Ignore our own broadcasts: the local runtime already applied them.
      if (envelope.origin === this.origin) return;
      void this.apply(envelope).catch((err) => {
        this.options.logger?.warn(
          `[runtime] 失效消息处理失败（${envelope.kind}:${envelope.id}）：${String(err)}`,
        );
      });
    });
    this.log(`已订阅运行时失效频道 ${this.channel()}`);
  }

  async stop(): Promise<void> {
    if (!this.subscriber) return;
    await this.subscriber.quit().catch(() => undefined);
    this.subscriber = null;
  }

  /**
   * Broadcast a change to every other replica. The caller is expected to have
   * already applied it locally. No-op without Redis.
   */
  async publish(change: RuntimeChange): Promise<void> {
    const redis = this.options.redis;
    if (!redis) return;
    const envelope: RuntimeEnvelope = { ...change, origin: this.origin };
    await redis.publish(this.channel(), JSON.stringify(envelope));
  }

  /** Apply a received change: reload the plugin, or refresh theme state. */
  async apply(change: RuntimeChange): Promise<void> {
    if (change.kind === 'theme') {
      await this.options.onThemeReload?.();
      return;
    }
    await this.reload(change.id);
  }

  /**
   * Idempotent runtime reload of one plugin: drop any existing registration,
   * re-read the definition from disk, then activate it when the database says
   * it is enabled. Safe to call with an unknown/absent plugin id (no-op).
   */
  async reload(pluginId: string): Promise<void> {
    const previous = this.locks.get(pluginId) ?? Promise.resolve();
    const run = previous.then(() => this.reloadUnlocked(pluginId));
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(pluginId, tail);
    try {
      await run;
    } finally {
      if (this.locks.get(pluginId) === tail) this.locks.delete(pluginId);
    }
  }

  private async reloadUnlocked(pluginId: string): Promise<void> {
    const { runtime } = this.options;
    if (runtime.has(pluginId)) {
      await runtime.unregister(pluginId);
    }
    let definition: PluginDefinition;
    try {
      definition = await this.options.loadDefinition(pluginId);
    } catch {
      // Not installed on this replica; nothing to converge.
      return;
    }
    await runtime.register(definition);
    let enabled: boolean;
    try {
      enabled = await this.options.isEnabled(pluginId);
    } catch {
      enabled = false;
    }
    if (enabled) {
      try {
        await runtime.activate(pluginId);
      } catch (err) {
        this.options.logger?.warn(
          `[runtime] 插件 ${pluginId} 激活失败（依赖或权限未就绪）：${String(err)}`,
        );
      }
    }
  }
}

function safeParse(value: string): RuntimeEnvelope | null {
  try {
    const parsed = JSON.parse(value) as Partial<RuntimeEnvelope>;
    if (typeof parsed.id !== 'string' || typeof parsed.origin !== 'string') return null;
    if (parsed.kind !== 'plugin' && parsed.kind !== 'theme') return null;
    const action = parsed.action;
    if (action !== 'activate' && action !== 'deactivate' && action !== 'reload' && action !== 'remove') {
      return null;
    }
    return { kind: parsed.kind, id: parsed.id, action, origin: parsed.origin };
  } catch {
    return null;
  }
}

// --- Process singleton -----------------------------------------------------

let singleton: RuntimeCoherence | null = null;

/**
 * Configure the process-wide coherence instance. Called from `buildApp` (API)
 * and by the worker entrypoint. Replaces any previous instance (tests build
 * multiple apps per process; the latest wins).
 */
export function configureRuntimeCoherence(options: RuntimeCoherenceOptions): RuntimeCoherence {
  singleton = new RuntimeCoherence(options);
  return singleton;
}

/** The configured instance, or null when `buildApp` has not run. */
export function getRuntimeCoherence(): RuntimeCoherence | null {
  return singleton;
}

/** Subscribe the configured instance (entrypoints only). */
export async function startRuntimeCoherence(): Promise<void> {
  await singleton?.start();
}

/** Stop the configured instance (shutdown/tests). */
export async function stopRuntimeCoherence(): Promise<void> {
  await singleton?.stop();
}

/** Broadcast a change through the process singleton; no-op when unconfigured. */
export async function publishRuntimeChange(change: RuntimeChange): Promise<void> {
  await singleton?.publish(change);
}

/** Drop the singleton (tests). */
export function resetRuntimeCoherence(): void {
  singleton = null;
}
