import { describe, expect, it, vi } from 'vitest';
import {
  ISOLATED_CONTEXT_SERVICES,
  SYNC_SERVICE_METHODS,
  SYNC_SERVICE_PREDICATES,
  isWireSafe,
  takeSyncServicePredicateInput,
  takeSyncServiceSnapshot,
} from '../../src/plugins/isolated/service-contract.ts';

/**
 * `sync-method contract` (spec/captcha-provider.md §15).
 *
 * Every kernel service method the SDK declares synchronous has to come back as a
 * value inside an isolated worker. Before this contract existed the worker proxied
 * them through the async capability channel, so a plugin received a `Promise`
 * where the SDK promised a `boolean` — and a pending promise is truthy, which
 * made `if (!ctx.secrets.isAvailable())` take the "configured" branch even with
 * no encryption key at all. The guard didn't fail loudly; it silently vanished.
 */
describe('isolated service contract', () => {
  const context = {
    auth: {
      sessionCookieConfig: () => ({ name: 'sp_session', ttlSeconds: 3600, secure: true }),
      verifyPassword: async () => true,
    },
    secrets: { isAvailable: () => false, get: async () => null },
    captcha: {
      mode: () => 'required' as const,
      isConfigured: () => true,
      providerIds: () => ['altcha'],
      verify: async () => ({ success: true }),
    },
    identity: {
      requiresEmailVerification: () => true,
      isDeliveryConfigured: () => false,
      senderIds: () => ['smtp'],
      issue: async () => ({ id: 'x' }),
    },
    payments: {
      listPaymentMethods: () => ({ wallet: { id: 'wallet', label: 'Wallet' }, providers: [] }),
      providerModes: () => ({ wallet: 'manual' as const, alipay: 'gateway' as const }),
      createRecord: async () => null,
    },
  };

  it('snapshots every SDK-declared synchronous value method', () => {
    const snapshot = takeSyncServiceSnapshot(context);
    expect(snapshot).toEqual({
      auth: { sessionCookieConfig: { name: 'sp_session', ttlSeconds: 3600, secure: true } },
      secrets: { isAvailable: false },
      captcha: { mode: 'required', isConfigured: true, providerIds: ['altcha'] },
      identity: {
        requiresEmailVerification: true,
        isDeliveryConfigured: false,
        senderIds: ['smtp'],
      },
      payments: {
        listPaymentMethods: { wallet: { id: 'wallet', label: 'Wallet' }, providers: [] },
        providerModes: { wallet: 'manual', alipay: 'gateway' },
      },
    });
  });

  it('snapshots only synchronous methods, never the async ones beside them', () => {
    const snapshot = takeSyncServiceSnapshot(context);
    expect(snapshot.auth).not.toHaveProperty('verifyPassword');
    expect(snapshot.secrets).not.toHaveProperty('get');
    expect(snapshot.captcha).not.toHaveProperty('verify');
    expect(snapshot.identity).not.toHaveProperty('issue');
    expect(snapshot.payments).not.toHaveProperty('createRecord');
  });

  it('records a falsey snapshot value instead of dropping it', () => {
    // The whole bug hinged on `false` being replaced by a truthy promise. A
    // snapshot that dropped `false` ("nothing to ship") would reintroduce it.
    const snapshot = takeSyncServiceSnapshot({
      secrets: { isAvailable: () => false },
      captcha: { isConfigured: () => false, providerIds: () => [], mode: () => 'off' },
    });
    expect(snapshot.secrets).toEqual({ isAvailable: false });
    expect(snapshot.captcha).toEqual({ mode: 'off', isConfigured: false, providerIds: [] });
    expect(Object.keys(snapshot.secrets ?? {})).toContain('isAvailable');
  });

  it('skips a method that is async in practice instead of freezing its promise', () => {
    // A declared-sync method that actually returns a promise must not enter the
    // snapshot: a frozen promise would be uncloneable or resolve to `{}`.
    const snapshot = takeSyncServiceSnapshot({
      secrets: { isAvailable: async () => true },
      captcha: { mode: () => 'optional' },
    });
    expect(snapshot.secrets).toBeUndefined();
    expect(snapshot.captcha).toEqual({ mode: 'optional' });
  });

  it('skips a method that throws rather than failing the whole snapshot', () => {
    const snapshot = takeSyncServiceSnapshot({
      secrets: {
        isAvailable: () => {
          throw new Error('config down');
        },
      },
      payments: { providerModes: () => ({}) },
    });
    expect(snapshot.secrets).toBeUndefined();
    expect(snapshot.payments).toEqual({ providerModes: {} });
  });

  it('skips values the wire cannot carry', () => {
    class NotJson {
      run(): void {}
    }
    const snapshot = takeSyncServiceSnapshot({
      auth: { sessionCookieConfig: () => new NotJson() },
      captcha: { mode: () => 'off' },
    });
    expect(snapshot.auth).toBeUndefined();
    expect(snapshot.captcha).toEqual({ mode: 'off' });
  });

  it('does not read services that are absent from the context', () => {
    expect(takeSyncServiceSnapshot({})).toEqual({});
  });

  it('only declares snapshot work for services the worker can reach', () => {
    // A snapshot for a service the worker has no `ctx.<name>` accessor for would
    // be dead weight — and worse, it would imply an authority that does not exist.
    for (const name of Object.keys(SYNC_SERVICE_METHODS)) {
      expect(ISOLATED_CONTEXT_SERVICES as readonly string[]).toContain(name);
    }
    for (const name of Object.keys(SYNC_SERVICE_PREDICATES)) {
      expect(ISOLATED_CONTEXT_SERVICES as readonly string[]).toContain(name);
    }
  });

  it('keeps the sync list in sync with the exact calls that used to break', () => {
    // Regression anchor for spec/captcha-provider.md §15.3. These are the calls
    // the altcha/smtp/alipay/epay/wechatpay/zjmf-upstream guards made.
    expect(SYNC_SERVICE_METHODS.secrets).toContain('isAvailable');
    expect(SYNC_SERVICE_METHODS.captcha).toEqual(
      expect.arrayContaining(['mode', 'isConfigured', 'providerIds']),
    );
    expect(SYNC_SERVICE_METHODS.identity).toEqual(
      expect.arrayContaining(['requiresEmailVerification', 'isDeliveryConfigured', 'senderIds']),
    );
    expect(SYNC_SERVICE_METHODS.payments).toEqual(
      expect.arrayContaining(['listPaymentMethods', 'providerModes']),
    );
    expect(SYNC_SERVICE_METHODS.auth).toContain('sessionCookieConfig');
  });

  it('does not claim currency helpers, which run locally in the worker', () => {
    // `currency.toMinor` / `currency.format` are pure functions the worker already
    // evaluates in-process; snapshotting them would ship a stale duplicate.
    expect(SYNC_SERVICE_METHODS.currency).toBeUndefined();
  });
});

describe('takeSyncServicePredicateInput', () => {
  /**
   * `notificationPolicy.declares(type)` takes an argument, so it can never be a
   * shipped *value*. The host ships the catalog and the worker rebuilds the same
   * exact/prefix match — otherwise `declares` would still be a promise, and
   * `if (!declares(type))` would be inverted for every isolated plugin.
   */
  it('ships the declared type catalog behind declares()', async () => {
    const listPolicy = vi.fn(async () => ({
      channels: [],
      categories: [],
      types: [{ type: 'store.order.paid' }, { type: 'agent.*' }, { type: 'system.plugin.install' }],
    }));
    const result = await takeSyncServicePredicateInput({
      notificationPolicy: { declares: () => true, listPolicy },
    });
    expect(listPolicy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      notificationPolicy: {
        declares: { types: ['store.order.paid', 'agent.*', 'system.plugin.install'] },
      },
    });
  });

  it('omits a service whose policy view cannot be read', async () => {
    const result = await takeSyncServicePredicateInput({
      notificationPolicy: {
        declares: () => true,
        listPolicy: async () => {
          throw new Error('db down');
        },
      },
    });
    // Absent means "fall back to the async proxy", which still answers correctly.
    expect(result).toEqual({});
  });

  it('omits a service that does not expose declares', async () => {
    const result = await takeSyncServicePredicateInput({
      notificationPolicy: { listPolicy: async () => ({ types: [{ type: 'x' }] }) },
    });
    expect(result).toEqual({});
  });

  it('omits a service that is absent', async () => {
    expect(await takeSyncServicePredicateInput({})).toEqual({});
  });
});

describe('isWireSafe', () => {
  it('accepts JSON-shaped values', () => {
    for (const value of [null, undefined, 0, '', false, [], {}, { a: { b: [1, 2] } }]) {
      expect(isWireSafe(value)).toBe(true);
    }
  });

  it('accepts the three types encodeWire gives explicit branches', () => {
    expect(isWireSafe(new Date())).toBe(true);
    expect(isWireSafe(new Uint8Array([1, 2]))).toBe(true);
    expect(isWireSafe(new Error('x'))).toBe(true);
  });

  it('rejects functions, symbols, bigints and cycles', () => {
    expect(isWireSafe(() => undefined)).toBe(false);
    expect(isWireSafe(Symbol('s'))).toBe(false);
    expect(isWireSafe(1n)).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(isWireSafe(cyclic)).toBe(false);
  });

  it('rejects a class instance, which would silently arrive as {}', () => {
    // `encodeWire` uses Object.entries, so an instance loses its identity without
    // any error — the exact silent-mangling class this check exists to stop.
    class SessionCookie {
      name = 'sp_session';
    }
    expect(isWireSafe(new SessionCookie())).toBe(false);
    expect(isWireSafe({ name: 'sp_session' })).toBe(true);
  });
});
