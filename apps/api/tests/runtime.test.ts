import { describe, expect, it, vi } from 'vitest';
import { definePlugin } from '@stackpanel/sdk';
import type { PluginContext } from '@stackpanel/sdk';
import { EventEmitterEventBus } from '../src/plugins/events.ts';
import { PluginRuntime } from '../src/plugins/runtime.ts';
import { stubExtensionRuntime } from './helpers.ts';

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('PluginRuntime', () => {
  it('runs lifecycle hooks in order and wires routes/events', async () => {
    const order: string[] = [];
    const events = new EventEmitterEventBus();
    const routes: Array<{ isActive: () => boolean }> = [];
    const eventsHeard: unknown[] = [];
    const runtime = new PluginRuntime({
      events,
      logger: silentLogger,
      db: null,
      registerRoute: (_pluginId, _route, isActive) => {
        routes.push({ isActive });
        return () => undefined;
      },
      removeRoutes: () => undefined,
      extensions: stubExtensionRuntime(),
      payments: {} as PluginContext['payments'],
      wallet: {} as PluginContext['wallet'],
      fx: {} as PluginContext['fx'],
      auth: {} as PluginContext['auth'],
      notifications: {} as PluginContext['notifications'],
      state: {} as PluginContext['state'],
      jobs: {
        enqueue: async () => '',
        schedule: async () => undefined,
        handle: () => () => undefined,
        removeByOwner: async () => undefined,
      } as never,
    });

    await runtime.register(
      definePlugin({
        manifest: { id: 'demo', name: 'Demo', version: '1.0.0' },
        routes: [{ method: 'GET', path: '/demo', handler: async () => ({ ok: true }) }],
        eventListeners: [{ topic: 'hello', handler: (p: unknown) => eventsHeard.push(p) }],
        onRegister: () => void order.push('register'),
        onActivate: () => void order.push('activate'),
        onDeactivate: () => void order.push('deactivate'),
      }),
    );

    expect(order).toEqual(['register']);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.isActive()).toBe(false);
    events.publish('hello', 'before');
    expect(eventsHeard).toEqual([]);

    await runtime.activate('demo');
    expect(order).toEqual(['register', 'activate']);
    expect(routes[0]?.isActive()).toBe(true);
    events.publish('hello', 'x');
    expect(eventsHeard).toEqual(['x']);

    await runtime.deactivate('demo');
    expect(order).toEqual(['register', 'activate', 'deactivate']);
    expect(routes[0]?.isActive()).toBe(false);
    events.publish('hello', 'y');
    expect(eventsHeard).toEqual(['x']);
  });

  it('unwinds ctx.effect registrations in reverse order and leaves no residue', async () => {
    const unwound: string[] = [];
    const events = new EventEmitterEventBus();
    const seen: unknown[] = [];
    const runtime = new PluginRuntime({
      events,
      logger: silentLogger,
      db: null,
      registerRoute: () => () => undefined,
      removeRoutes: () => undefined,
      extensions: stubExtensionRuntime(),
      payments: {} as PluginContext['payments'],
      wallet: {} as PluginContext['wallet'],
      fx: {} as PluginContext['fx'],
      auth: {} as PluginContext['auth'],
      notifications: {} as PluginContext['notifications'],
      state: {} as PluginContext['state'],
      jobs: {
        enqueue: async () => '',
        schedule: async () => undefined,
        handle: () => () => undefined,
        removeByOwner: async () => undefined,
      } as never,
    });

    await runtime.register(
      definePlugin({
        manifest: { id: 'effectful', name: 'Effectful', version: '1.0.0' },
        onActivate: (ctx) => {
          ctx.effect(() => {
            const off = ctx.events.subscribe('ping', (p: unknown) => seen.push(p));
            return () => {
              off();
              unwound.push('subscription');
            };
          });
          ctx.effect((collect) => {
            collect(() => unwound.push('explicit-1'));
            collect(() => unwound.push('explicit-2'));
          });
        },
      }),
    );

    await runtime.activate('effectful');
    events.publish('ping', 'live');
    expect(seen).toEqual(['live']);

    await runtime.deactivate('effectful');
    // Reverse (LIFO): the second effect's disposers unwind before the first's,
    // and within an effect the collected disposers run last-registered-first.
    expect(unwound).toEqual(['explicit-2', 'explicit-1', 'subscription']);

    // Deactivation left no residue: the event no longer reaches the plugin.
    events.publish('ping', 'after');
    expect(seen).toEqual(['live']);
  });

  it('does not accumulate effects across a deactivate/reactivate cycle', async () => {
    const events = new EventEmitterEventBus();
    const seen: unknown[] = [];
    const runtime = new PluginRuntime({
      events,
      logger: silentLogger,
      db: null,
      registerRoute: () => () => undefined,
      removeRoutes: () => undefined,
      extensions: stubExtensionRuntime(),
      payments: {} as PluginContext['payments'],
      wallet: {} as PluginContext['wallet'],
      fx: {} as PluginContext['fx'],
      auth: {} as PluginContext['auth'],
      notifications: {} as PluginContext['notifications'],
      state: {} as PluginContext['state'],
      jobs: {
        enqueue: async () => '',
        schedule: async () => undefined,
        handle: () => () => undefined,
        removeByOwner: async () => undefined,
      } as never,
    });
    await runtime.register(
      definePlugin({
        manifest: { id: 'cycle', name: 'Cycle', version: '1.0.0' },
        onActivate: (ctx) => {
          // The pattern the store plugin uses: an effect that owns a subscription.
          ctx.effect(() => ctx.events.subscribe('tick', (p: unknown) => seen.push(p)));
        },
      }),
    );

    await runtime.activate('cycle');
    events.publish('tick', 1);
    await runtime.deactivate('cycle');
    await runtime.activate('cycle');
    events.publish('tick', 2);

    // Exactly one live subscription after the cycle — a leaked disposer would
    // have produced [1, 2, 2] by delivering the second tick twice.
    expect(seen).toEqual([1, 2]);
  });

  it('lets a plugin provide a named service another plugin injects', async () => {
    const runtime = new PluginRuntime({
      events: new EventEmitterEventBus(),
      logger: silentLogger,
      db: null,
      registerRoute: () => () => undefined,
      removeRoutes: () => undefined,
      extensions: stubExtensionRuntime(),
      payments: {} as PluginContext['payments'],
      wallet: {} as PluginContext['wallet'],
      fx: {} as PluginContext['fx'],
      auth: {} as PluginContext['auth'],
      notifications: {} as PluginContext['notifications'],
      state: {} as PluginContext['state'],
      jobs: {
        enqueue: async () => '',
        schedule: async () => undefined,
        handle: () => () => undefined,
        removeByOwner: async () => undefined,
      } as never,
    });

    const capability = { greet: (name: string) => `hi ${name}` };
    await runtime.register(
      definePlugin({
        manifest: { id: 'provider', name: 'Provider', version: '1.0.0' },
        onActivate: (ctx) => {
          ctx.provide('greeter', capability);
        },
      }),
    );
    await runtime.register(
      definePlugin({
        manifest: { id: 'consumer', name: 'Consumer', version: '1.0.0' },
        inject: ['greeter'],
        onActivate: (ctx) => {
          const greeter = ctx.requireService<typeof capability>('greeter');
          expect(greeter.greet('x')).toBe('hi x');
        },
      }),
    );

    // The consumer cannot activate while its injected service is absent.
    await expect(runtime.activate('consumer')).rejects.toThrow('缺少注入服务 greeter');

    await runtime.activate('provider');
    await runtime.activate('consumer');
    expect(runtime.getService<typeof capability>('greeter')).toBe(capability);

    // Deactivating the provider withdraws the service (reverse effect).
    await runtime.deactivate('consumer');
    await runtime.deactivate('provider');
    expect(runtime.getService('greeter')).toBeUndefined();
    await expect(runtime.activate('consumer')).rejects.toThrow('缺少注入服务 greeter');
  });

  it('broadcasts plugin.activated / plugin.deactivated events', async () => {
    const events = new EventEmitterEventBus();
    const heard: unknown[] = [];
    events.subscribe('plugin.activated', (p: unknown) => heard.push(['a', p]));
    events.subscribe('plugin.deactivated', (p: unknown) => heard.push(['d', p]));
    const runtime = new PluginRuntime({
      events,
      logger: silentLogger,
      db: null,
      registerRoute: () => () => undefined,
      removeRoutes: () => undefined,
      extensions: stubExtensionRuntime(),
      payments: {} as PluginContext['payments'],
      wallet: {} as PluginContext['wallet'],
      fx: {} as PluginContext['fx'],
      auth: {} as PluginContext['auth'],
      notifications: {} as PluginContext['notifications'],
      state: {} as PluginContext['state'],
      jobs: {
        enqueue: async () => '',
        schedule: async () => undefined,
        handle: () => () => undefined,
        removeByOwner: async () => undefined,
      } as never,
    });
    await runtime.register(definePlugin({ manifest: { id: 'p', name: 'P', version: '1.0.0' } }));
    await runtime.activate('p');
    await runtime.deactivate('p');
    expect(heard).toEqual([
      ['a', { pluginId: 'p' }],
      ['d', { pluginId: 'p' }],
    ]);
  });

  it('rejects duplicate registration and unknown ids', async () => {
    const runtime = new PluginRuntime({
      events: new EventEmitterEventBus(),
      logger: silentLogger,
      db: null,
      registerRoute: () => () => undefined,
      removeRoutes: () => undefined,
      extensions: stubExtensionRuntime(),
      payments: {} as PluginContext['payments'],
      wallet: {} as PluginContext['wallet'],
      fx: {} as PluginContext['fx'],
      auth: {} as PluginContext['auth'],
      notifications: {} as PluginContext['notifications'],
      state: {} as PluginContext['state'],
      jobs: {
        enqueue: async () => '',
        schedule: async () => undefined,
        handle: () => () => undefined,
        removeByOwner: async () => undefined,
      } as never,
    });
    const def = definePlugin({ manifest: { id: 'p', name: 'P', version: '1.0.0' } });
    await runtime.register(def);
    await expect(runtime.register(def)).rejects.toThrow('已注册');
    await expect(runtime.activate('missing')).rejects.toThrow('不存在');
  });

  it('cleans up partial registration and activation failures', async () => {
    const removed: string[] = [];
    const runtime = new PluginRuntime({
      events: new EventEmitterEventBus(),
      logger: silentLogger,
      db: null,
      registerRoute: () => () => undefined,
      removeRoutes: (id) => removed.push(id),
      extensions: stubExtensionRuntime(),
      payments: {} as PluginContext['payments'],
      wallet: {} as PluginContext['wallet'],
      fx: {} as PluginContext['fx'],
      auth: {} as PluginContext['auth'],
      notifications: {} as PluginContext['notifications'],
      state: {} as PluginContext['state'],
      jobs: {
        enqueue: async () => '',
        schedule: async () => undefined,
        handle: () => () => undefined,
        removeByOwner: async () => undefined,
      } as never,
    });
    await expect(
      runtime.register(
        definePlugin({
          manifest: { id: 'broken-register', name: 'Broken', version: '1.0.0' },
          onRegister: () => {
            throw new Error('register failure');
          },
        }),
      ),
    ).rejects.toThrow('register failure');
    expect(runtime.has('broken-register')).toBe(false);
    expect(removed).toContain('broken-register');

    const extension = { id: 'temporary' };
    await runtime.register(
      definePlugin({
        manifest: { id: 'broken-activate', name: 'Broken', version: '1.0.0' },
        onActivate: (ctx) => {
          ctx.registerExtension('test.extension', extension);
          throw new Error('activate failure');
        },
      }),
    );
    await expect(runtime.activate('broken-activate')).rejects.toThrow('activate failure');
    expect(runtime.isActive('broken-activate')).toBe(false);
    expect(runtime.getExtensions('test.extension')).toEqual([]);
  });

  it('registers and unregisters extension implementations per plugin', async () => {
    const events = new EventEmitterEventBus();
    const runtime = new PluginRuntime({
      events,
      logger: silentLogger,
      db: null,
      registerRoute: () => () => undefined,
      removeRoutes: () => undefined,
      extensions: stubExtensionRuntime(),
      payments: {} as PluginContext['payments'],
      wallet: {} as PluginContext['wallet'],
      fx: {} as PluginContext['fx'],
      auth: {} as PluginContext['auth'],
      notifications: {} as PluginContext['notifications'],
      state: {} as PluginContext['state'],
      jobs: {
        enqueue: async () => '',
        schedule: async () => undefined,
        handle: () => () => undefined,
        removeByOwner: async () => undefined,
      } as never,
    });
    const impl = { auth: () => null };
    await runtime.register(
      definePlugin({
        manifest: { id: 'auth', name: 'Auth', version: '1.0.0' },
        onActivate: (ctx: PluginContext) => {
          ctx.registerExtension('auth.provider', impl);
        },
      }),
    );
    await runtime.activate('auth');
    expect(runtime.getExtensions('auth.provider')).toEqual([impl]);
    expect(runtime.getExtensionsWithOwner('auth.provider')).toEqual([
      { pluginId: 'auth', implementation: impl },
    ]);

    await runtime.deactivate('auth');
    expect(runtime.getExtensions('auth.provider')).toEqual([]);
  });

  it('activates required plugins first and blocks breaking dependency shutdown', async () => {
    const order: string[] = [];
    const runtime = new PluginRuntime({
      events: new EventEmitterEventBus(),
      logger: silentLogger,
      db: null,
      registerRoute: () => () => undefined,
      removeRoutes: () => undefined,
      extensions: stubExtensionRuntime(),
      payments: {} as PluginContext['payments'],
      wallet: {} as PluginContext['wallet'],
      fx: {} as PluginContext['fx'],
      auth: {} as PluginContext['auth'],
      notifications: {} as PluginContext['notifications'],
      state: {} as PluginContext['state'],
      jobs: {
        enqueue: async () => '',
        schedule: async () => undefined,
        handle: () => () => undefined,
        removeByOwner: async () => undefined,
      } as never,
    });
    await runtime.register(
      definePlugin({
        manifest: { id: 'base', name: 'Base', version: '1.0.0' },
        onActivate: () => void order.push('base:activate'),
        onDeactivate: () => void order.push('base:deactivate'),
      }),
    );
    await runtime.register(
      definePlugin({
        manifest: {
          id: 'app',
          name: 'App',
          version: '1.0.0',
          requires: ['base'],
        },
        onActivate: () => void order.push('app:activate'),
        onDeactivate: () => void order.push('app:deactivate'),
      }),
    );

    await runtime.activate('app');
    expect(order).toEqual(['base:activate', 'app:activate']);
    await expect(runtime.deactivate('base')).rejects.toThrow('被已启用的插件依赖');
    await runtime.deactivate('app');
    await runtime.deactivate('base');
    expect(order).toEqual(['base:activate', 'app:activate', 'app:deactivate', 'base:deactivate']);
  });

  it('rejects activation when a required plugin is missing', async () => {
    const runtime = new PluginRuntime({
      events: new EventEmitterEventBus(),
      logger: silentLogger,
      db: null,
      registerRoute: () => () => undefined,
      removeRoutes: () => undefined,
      extensions: stubExtensionRuntime(),
      payments: {} as PluginContext['payments'],
      wallet: {} as PluginContext['wallet'],
      fx: {} as PluginContext['fx'],
      auth: {} as PluginContext['auth'],
      notifications: {} as PluginContext['notifications'],
      state: {} as PluginContext['state'],
      jobs: {
        enqueue: async () => '',
        schedule: async () => undefined,
        handle: () => () => undefined,
        removeByOwner: async () => undefined,
      } as never,
    });
    await runtime.register(
      definePlugin({
        manifest: { id: 'app', name: 'App', version: '1.0.0', requires: ['missing'] },
      }),
    );
    await expect(runtime.activate('app')).rejects.toThrow('缺少依赖插件 missing');
  });

  it('activates dependencies with semver ranges and rejects incompatible versions', async () => {
    const ok = new PluginRuntime({
      events: new EventEmitterEventBus(),
      logger: silentLogger,
      db: null,
      registerRoute: () => () => undefined,
      removeRoutes: () => undefined,
      extensions: stubExtensionRuntime(),
      payments: {} as PluginContext['payments'],
      wallet: {} as PluginContext['wallet'],
      fx: {} as PluginContext['fx'],
      auth: {} as PluginContext['auth'],
      notifications: {} as PluginContext['notifications'],
      state: {} as PluginContext['state'],
      jobs: {
        enqueue: async () => '',
        schedule: async () => undefined,
        handle: () => () => undefined,
        removeByOwner: async () => undefined,
      } as never,
    });
    await ok.register(definePlugin({ manifest: { id: 'base', name: 'Base', version: '1.2.0' } }));
    await ok.register(
      definePlugin({
        manifest: {
          id: 'app',
          name: 'App',
          version: '1.0.0',
          requires: [{ id: 'base', range: '^1.0.0' }],
        },
      }),
    );
    await expect(ok.activate('app')).resolves.toBeUndefined();

    const bad = new PluginRuntime({
      events: new EventEmitterEventBus(),
      logger: silentLogger,
      db: null,
      registerRoute: () => () => undefined,
      removeRoutes: () => undefined,
      extensions: stubExtensionRuntime(),
      payments: {} as PluginContext['payments'],
      wallet: {} as PluginContext['wallet'],
      fx: {} as PluginContext['fx'],
      auth: {} as PluginContext['auth'],
      notifications: {} as PluginContext['notifications'],
      state: {} as PluginContext['state'],
      jobs: {
        enqueue: async () => '',
        schedule: async () => undefined,
        handle: () => () => undefined,
        removeByOwner: async () => undefined,
      } as never,
    });
    await bad.register(definePlugin({ manifest: { id: 'base', name: 'Base', version: '1.0.0' } }));
    await bad.register(
      definePlugin({
        manifest: {
          id: 'app',
          name: 'App',
          version: '1.0.0',
          requires: [{ id: 'base', range: '^2.0.0' }],
        },
      }),
    );
    await expect(bad.activate('app')).rejects.toThrow('需要 base@^2.0.0');
  });

  it('allows optional missing dependencies and rejects circular graphs', async () => {
    const runtime = new PluginRuntime({
      events: new EventEmitterEventBus(),
      logger: silentLogger,
      db: null,
      registerRoute: () => () => undefined,
      removeRoutes: () => undefined,
      extensions: stubExtensionRuntime(),
      payments: {} as PluginContext['payments'],
      wallet: {} as PluginContext['wallet'],
      fx: {} as PluginContext['fx'],
      auth: {} as PluginContext['auth'],
      notifications: {} as PluginContext['notifications'],
      state: {} as PluginContext['state'],
      jobs: {
        enqueue: async () => '',
        schedule: async () => undefined,
        handle: () => () => undefined,
        removeByOwner: async () => undefined,
      } as never,
    });
    await runtime.register(
      definePlugin({
        manifest: {
          id: 'optional',
          name: 'Optional',
          version: '1.0.0',
          requires: [{ id: 'missing', optional: true }],
        },
      }),
    );
    await expect(runtime.activate('optional')).resolves.toBeUndefined();

    await runtime.register(
      definePlugin({ manifest: { id: 'a', name: 'A', version: '1.0.0', requires: ['b'] } }),
    );
    await runtime.register(
      definePlugin({ manifest: { id: 'b', name: 'B', version: '1.0.0', requires: ['a'] } }),
    );
    await expect(runtime.activate('a')).rejects.toThrow('插件依赖出现循环');
  });

  it('validates provides/consumes extension points before activation', async () => {
    const runtime = new PluginRuntime({
      events: new EventEmitterEventBus(),
      logger: silentLogger,
      db: null,
      registerRoute: () => () => undefined,
      removeRoutes: () => undefined,
      extensions: stubExtensionRuntime(),
      payments: {} as PluginContext['payments'],
      wallet: {} as PluginContext['wallet'],
      fx: {} as PluginContext['fx'],
      auth: {} as PluginContext['auth'],
      notifications: {} as PluginContext['notifications'],
      state: {} as PluginContext['state'],
      jobs: {
        enqueue: async () => '',
        schedule: async () => undefined,
        handle: () => () => undefined,
        removeByOwner: async () => undefined,
      } as never,
    });
    await runtime.register(
      definePlugin({
        manifest: {
          id: 'provider',
          name: 'Provider',
          version: '1.0.0',
          provides: ['orders.render'],
        },
      }),
    );
    await runtime.register(
      definePlugin({
        manifest: {
          id: 'consumer',
          name: 'Consumer',
          version: '1.0.0',
          consumes: [{ pluginId: 'provider', extensionPoint: 'orders.render' }],
        },
      }),
    );
    await expect(runtime.activate('consumer')).rejects.toThrow(
      '消费了不存在的扩展点 provider:orders.render',
    );
    await runtime.activate('provider');
    await expect(runtime.activate('consumer')).resolves.toBeUndefined();
  });

  it('exposes declared plugin permissions on the runtime', async () => {
    const runtime = new PluginRuntime({
      events: new EventEmitterEventBus(),
      logger: silentLogger,
      db: null,
      registerRoute: () => () => undefined,
      removeRoutes: () => undefined,
      extensions: stubExtensionRuntime(),
      payments: {} as PluginContext['payments'],
      wallet: {} as PluginContext['wallet'],
      fx: {} as PluginContext['fx'],
      auth: {} as PluginContext['auth'],
      notifications: {} as PluginContext['notifications'],
      state: {} as PluginContext['state'],
      jobs: {
        enqueue: async () => '',
        schedule: async () => undefined,
        handle: () => () => undefined,
        removeByOwner: async () => undefined,
      } as never,
    });
    await runtime.register(
      definePlugin({
        manifest: {
          id: 'rbac',
          name: 'RBAC',
          version: '1.0.0',
          permissions: ['orders:read'],
        },
      }),
    );
    expect(runtime.list().find((plugin) => plugin.id === 'rbac')?.permissions).toEqual([
      'orders:read',
    ]);
  });
});
