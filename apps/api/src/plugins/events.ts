import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { RedisClient } from '@stackpanel/db';
import { REDIS_KEY_PREFIX } from '@stackpanel/sdk';
import type { EventBus, EventPayload, WaterfallListener } from '@stackpanel/sdk';

/**
 * Single-machine event bus backed by Node's EventEmitter.
 * The {@link EventBus} interface is the cluster seam: a Redis Pub/Sub driver
 * can be swapped in later without touching publishers/subscribers.
 *
 * Two dispatch modes live here:
 * - `publish`/`subscribe` broadcast a fact; listeners only observe.
 * - `intercept`/`waterfall` run a synchronous around-pipeline; listeners are
 *   policy that can rewrite the value or stop the chain.
 */
export class EventEmitterEventBus implements EventBus {
  private readonly emitter = new EventEmitter();
  private readonly interceptors = new Map<string, Array<WaterfallListener<unknown>>>();

  publish<K extends string>(topic: K, payload?: EventPayload<K>): void {
    this.deliver(topic, payload);
  }

  /**
   * Deliver a local broadcast. `publish` and the outbox relay both route
   * through here; a failing listener never breaks the caller (the state change
   * already happened, so the request must not turn into a 500).
   */
  deliver<K extends string>(topic: K, payload?: EventPayload<K>): void {
    for (const listener of this.emitter.listeners(topic)) {
      try {
        listener(payload);
      } catch (err) {
        console.error(`[events] listener for "${topic}" failed`, err);
      }
    }
  }

  subscribe<K extends string>(topic: K, handler: (payload: EventPayload<K>) => void): () => void {
    this.emitter.on(topic, handler as (payload: unknown) => void);
    return () => {
      this.emitter.off(topic, handler as (payload: unknown) => void);
    };
  }

  intercept<T>(topic: string, listener: WaterfallListener<T>): () => void {
    const list = this.interceptors.get(topic) ?? [];
    list.push(listener as WaterfallListener<unknown>);
    this.interceptors.set(topic, list);
    return () => {
      const index = list.lastIndexOf(listener as WaterfallListener<unknown>);
      if (index >= 0) {
        list.splice(index, 1);
      }
      if (list.length === 0) {
        this.interceptors.delete(topic);
      }
    };
  }

  waterfall<T>(topic: string, value: T, terminal: (value: T) => T): T {
    const listeners = this.interceptors.get(topic) ?? [];
    const chain = listeners.map((listener) => listener as WaterfallListener<T>);
    let index = 0;
    const dispatch = (current: T): T => {
      const listener = chain[index];
      if (!listener) {
        return terminal(current);
      }
      index += 1;
      let delegated = false;
      const next = (nextValue: T): T => {
        if (delegated) {
          throw new Error(`waterfall "${topic}": next() called multiple times`);
        }
        delegated = true;
        return dispatch(nextValue);
      };
      return listener(current, next);
    };
    return dispatch(value);
  }
}

/**
 * Durable event bus (S5 / ADR-0013).
 *
 * `publish` does two things:
 *   1. persists the event to the transactional outbox, so a crash before the
 *      relay runs does not lose it (at-least-once); and
 *   2. delivers it locally and immediately through the embedded
 *      {@link EventEmitterEventBus}, so same-process subscribers keep their
 *      existing low-latency, synchronous-in-practice behaviour.
 *
 * A relay loop then claims published-but-undelivered rows and:
 *   - re-delivers locally (covering the crash-recovery case), and
 *   - publishes to Redis Pub/Sub for cross-replica delivery.
 *
 * Local delivery failures are still isolated per listener by the inner bus, so
 * this class only concerns itself with persistence and cluster fan-out.
 */
export interface OutboxOptions {
  db: PrismaClientLike;
  redis: RedisClient | null;
  production: boolean;
  logger?: { warn: (m: string) => void; info: (m: string) => void };
  /** Relay poll interval; defaults to 2s. */
  intervalMs?: number;
  /** Rows claimed per relay pass. */
  batchSize?: number;
  /** Claim lease; expired leases are retried by any replica. */
  leaseMs?: number;
}

export class OutboxEventBus implements EventBus {
  private readonly local = new EventEmitterEventBus();
  private relayTimer: ReturnType<typeof setInterval> | null = null;
  private subscriber: RedisClient | null = null;
  private running = false;
  private relayPasses = 0;
  private readonly origin = randomUUID().slice(0, 8);
  private options: OutboxOptions | null = null;

  /**
   * Bind the outbox backing store. The kernel calls this from `initInfra()`
   * after the DB is reachable; until then `publish` behaves as a pure in-process
   * bus (development fallback and early lifecycle events).
   */
  configure(options: OutboxOptions): void {
    this.options = options;
  }

  // --- EventBus surface (delegates to the local engine) ---------------------

  publish<K extends string>(topic: K, payload?: EventPayload<K>): void {
    // Before the outbox is bound (development/tests/early boot) behave exactly
    // like the in-process bus: deliver synchronously and forget.
    if (!this.options) {
      this.local.deliver(topic, payload);
      return;
    }
    // Outbox mode: persist, then let the relay deliver. Delivering here too
    // would double-fire every subscriber (once inline, once on relay), which
    // would double-provision workloads — so delivery is owned by the relay.
    const body = this.serialize(topic, payload);
    void this.enqueue(topic, body);
  }

  subscribe<K extends string>(topic: K, handler: (payload: EventPayload<K>) => void): () => void {
    return this.local.subscribe(topic, handler);
  }

  intercept<T>(topic: string, listener: WaterfallListener<T>): () => void {
    return this.local.intercept(topic, listener);
  }

  waterfall<T>(topic: string, value: T, terminal: (value: T) => T): T {
    return this.local.waterfall(topic, value, terminal);
  }

  // --- Lifecycle ------------------------------------------------------------

  /**
   * Start the relay and, when Redis is configured, subscribe to the cross-node
   * channel. Called from `initInfra()` after the DB/Redis are ready.
   */
  start(): void {
    if (this.relayTimer || !this.options) return;
    const interval = this.options.intervalMs ?? 2000;
    // Retention is enforced roughly hourly (every N relay passes), not on every
    // pass, so the hot path stays a single indexed query.
    const passesPerCleanup = Math.max(1, Math.round((60 * 60 * 1000) / interval));
    this.relayTimer = setInterval(() => {
      void this.relay().catch((err) => {
        this.options?.logger?.warn(`[outbox] relay pass failed: ${String(err)}`);
      });
      this.relayPasses += 1;
      if (this.relayPasses % passesPerCleanup === 0) {
        void this.cleanup().catch(() => undefined);
      }
    }, interval);
    this.relayTimer.unref?.();
    void this.relay().catch(() => undefined);
    void this.subscribeRemote();
  }

  async stop(): Promise<void> {
    if (this.relayTimer) {
      clearInterval(this.relayTimer);
      this.relayTimer = null;
    }
    if (this.subscriber) {
      await this.subscriber.quit().catch(() => undefined);
      this.subscriber = null;
    }
  }

  /** Run one relay pass synchronously (tests / shutdown drain). */
  async relay(): Promise<void> {
    const options = this.options;
    if (!options || this.running) return;
    this.running = true;
    try {
      const now = new Date();
      const leaseCutoff = new Date(now.getTime() - (options.leaseMs ?? 30_000));
      const rows = await options.db.outboxEvent.findMany({
        where: {
          publishedAt: null,
          OR: [{ lockedAt: null }, { lockedAt: { lt: leaseCutoff } }],
        },
        orderBy: { createdAt: 'asc' },
        take: options.batchSize ?? 50,
      });
      for (const row of rows) {
        await this.claimAndDeliver(row);
      }
    } finally {
      this.running = false;
    }
  }

  /** Report undelivered backlog (health/metrics). */
  async pendingCount(): Promise<number> {
    if (!this.options) return 0;
    return this.options.db.outboxEvent.count({ where: { publishedAt: null } });
  }

  /**
   * Trim delivered rows older than the retention window. The outbox grows one
   * row per published event, so unbounded growth would bloat the table; rows are
   * safe to delete once published. Unpublished rows are never touched.
   */
  async cleanup(retentionMs = 7 * 24 * 60 * 60 * 1000): Promise<number> {
    if (!this.options) return 0;
    const cutoff = new Date(Date.now() - retentionMs);
    const { count } = await this.options.db.outboxEvent.deleteMany({
      where: { publishedAt: { not: null, lt: cutoff } },
    });
    return count;
  }

  // --- Internals ------------------------------------------------------------

  private async enqueue(topic: string, body: string): Promise<void> {
    if (!this.options) return;
    try {
      await this.options.db.outboxEvent.create({
        data: { topic, payload: { body }, origin: this.origin },
      });
      // Low latency: nudge the relay now instead of waiting for the interval.
      // Bursts coalesce because `relay` is re-entrancy-guarded.
      void this.relay().catch(() => undefined);
    } catch (err) {
      // Never throw from publish: losing durability is preferable to 500ing a
      // business write, but it is surfaced loudly for alerting.
      const scope = this.options.production ? 'production' : 'development';
      this.options.logger?.warn(`[outbox] persist failed (${scope}) for "${topic}": ${String(err)}`);
    }
  }

  private async claimAndDeliver(row: OutboxRow): Promise<void> {
    const options = this.options;
    if (!options) return;
    // Atomic claim: the lock conditions are part of the UPDATE WHERE, so two
    // replicas that both saw the row cannot both claim it (the loser's UPDATE
    // matches zero rows once the winner's timestamp is committed).
    const leaseCutoff = new Date(Date.now() - (options.leaseMs ?? 30_000));
    const claim = await options.db.outboxEvent.updateMany({
      where: {
        id: row.id,
        publishedAt: null,
        OR: [{ lockedAt: null }, { lockedAt: { lt: leaseCutoff } }],
      },
      data: { lockedAt: new Date(), lockedBy: this.origin, attempts: { increment: 1 } },
    });
    if (claim.count === 0) return;

    const payload = decodeBody(row.payload);
    try {
      // Re-deliver locally for crash recovery.
      this.local.deliver(row.topic, payload);
      await this.publishRemote(row.topic, payload);
      await options.db.outboxEvent.updateMany({
        where: { id: row.id },
        data: { publishedAt: new Date(), lockedAt: null, lockedBy: null, lastError: null },
      });
    } catch (err) {
      await options.db.outboxEvent.updateMany({
        where: { id: row.id },
        data: { lockedAt: null, lockedBy: null, lastError: String(err).slice(0, 1000) },
      });
    }
  }

  private async subscribeRemote(): Promise<void> {
    const redis = this.options?.redis;
    if (!redis) return;
    this.subscriber = redis.duplicate();
    await this.subscriber.subscribe(channelName());
    this.subscriber.on('message', (_channel: string, message: string) => {
      const envelope = safeParse(message);
      if (!envelope) return;
      // Skip our own broadcasts: they were already delivered locally.
      if (envelope.origin === this.origin) return;
      this.local.deliver(envelope.topic, envelope.payload);
    });
  }

  private async publishRemote(topic: string, payload: unknown): Promise<void> {
    const redis = this.options?.redis;
    if (!redis) return;
    await redis.publish(channelName(), JSON.stringify({ topic, payload, origin: this.origin }));
  }

  private serialize(topic: string, payload: unknown): string {
    try {
      return JSON.stringify({ topic, payload, origin: this.origin });
    } catch {
      return JSON.stringify({ topic, origin: this.origin });
    }
  }
}

/** Minimal Prisma surface the outbox needs (avoids importing the client type). */
interface PrismaClientLike {
  outboxEvent: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
    findMany(args: unknown): Promise<OutboxRow[]>;
    updateMany(args: unknown): Promise<{ count: number }>;
    count(args: unknown): Promise<number>;
    deleteMany(args: unknown): Promise<{ count: number }>;
  };
}

interface OutboxRow {
  id: string;
  topic: string;
  payload: unknown;
}

/** Decode the stored envelope back into the original payload. */
function decodeBody(payload: unknown): unknown {
  if (payload && typeof payload === 'object' && 'body' in payload) {
    const body = (payload as { body?: unknown }).body;
    if (typeof body === 'string') {
      const parsed = safeParse(body);
      return parsed ? parsed.payload : undefined;
    }
  }
  return payload;
}

function safeParse(value: string): { topic: string; payload: unknown; origin?: string } | null {
  try {
    const parsed = JSON.parse(value) as { topic?: unknown; payload?: unknown; origin?: unknown };
    if (typeof parsed.topic !== 'string') return null;
    return {
      topic: parsed.topic,
      payload: parsed.payload,
      ...(typeof parsed.origin === 'string' ? { origin: parsed.origin } : {}),
    };
  } catch {
    return null;
  }
}

/** Redis Pub/Sub channel for cross-replica event fan-out. */
function channelName(): string {
  return `${REDIS_KEY_PREFIX.pubsub}events`;
}

/**
 * Process-wide event bus. It is a durable outbox bus from the start, but stays
 * a pure in-process bus until `configureOutboxEventBus` binds its backing store
 * (called from `initInfra()`). Because services capture this reference at
 * `buildApp()` time, the object identity must never change.
 */
const bus = new OutboxEventBus();

/** Process-wide event bus singleton. */
export function getEventBus(): EventBus {
  return bus;
}

/** The concrete outbox bus (kernel relay wiring, health/metrics). */
export function getOutboxBus(): OutboxEventBus {
  return bus;
}

/**
 * Bind the durable outbox backing store and start the relay + cross-node
 * subscription when Redis is available. Idempotent.
 */
export function configureOutboxEventBus(options: OutboxOptions): OutboxEventBus {
  bus.configure(options);
  bus.start();
  return bus;
}
