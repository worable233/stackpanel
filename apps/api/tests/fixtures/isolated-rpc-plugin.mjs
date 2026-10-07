import { z } from 'zod';

let pluginContext;
const model = {
  kind: 'rpc/note',
  label: 'RPC note',
  schema: z.object({ title: z.string() }),
  indexes: [{ fields: ['title'], types: { title: 'string' } }],
};

export default {
  routes: [
    { method: 'GET', path: '/probe', handler: async () => ({ ok: true }) },
    {
      method: 'GET',
      path: '/services',
      handler: async () => ({
        account: await pluginContext.wallet.getAccount('user-1'),
        rate: await pluginContext.fx.getRate('USD', 'CNY'),
        methods: await pluginContext.payments.listPaymentMethods(),
      }),
    },
    {
      method: 'GET',
      path: '/models',
      handler: async () => {
        const created = await pluginContext.extensions.create(model, { title: 'hello' }, { name: 'note-1' });
        return pluginContext.extensions.get(model, created.name);
      },
    },
    {
      method: 'GET',
      path: '/sync-services',
      handler: async () => ({
        cookie: pluginContext.auth.sessionCookieConfig(),
        secrets: pluginContext.secrets.isAvailable(),
        methods: pluginContext.payments.listPaymentMethods(),
      }),
    },
      {
        method: 'GET',
        path: '/state-lock',
        handler: async () => pluginContext.state.withLock('rpc-lock', 1000, async () => undefined),
      },
      {
        method: 'GET',
        path: '/crash',
        handler: async () => {
          globalThis.process.nextTick(() => globalThis.process.exit(42));
          await new Promise(() => undefined);
        },
      },
    {
      method: 'GET',
      path: '/snapshot',
      handler: async () => {
        const extension = pluginContext.getExtensions('probe.point')[0];
        return { id: extension.id, result: await extension.run('x') };
      },
    },
  ],
  customModels: [model],
  eventListeners: [{
    topic: 'probe.declarative',
    handler: (payload) => {
      // Declarative listeners use the same worker-owned callback boundary.
      void payload;
    },
  }, {
    topic: 'probe.failing',
    handler: () => {
      throw new Error('listener failure');
    },
  }],
  onActivate(ctx) {
    pluginContext = ctx;
    ctx.events.subscribe('probe.event', (payload) => {
      ctx.logger.info(`event:${payload.value}`);
    });
    ctx.jobs.handle('probe.job', async (payload) => {
      await ctx.jobs.enqueue('probe.followup', payload, { jobId: 'probe-followup' });
    });
    ctx.provide('probe.service', {
      version: '1',
      greet: (name) => `hello ${name}`,
    });
    ctx.registerExtension('probe.extension', {
      id: 'rpc-extension',
      run: async (value) => value,
    });
  },
};
