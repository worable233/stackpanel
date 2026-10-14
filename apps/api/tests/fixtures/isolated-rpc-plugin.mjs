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
        path: '/cache',
        handler: async () => {
          // 跨进程缓存的语义：命中就不回源；未命中回源后由内核侧留存。
          let loads = 0;
          const read = () => pluginContext.cache.remember(
            'rpc-cache-probe',
            { ttlMs: 30_000, kinds: ['rpc/note'] },
            async () => { loads += 1; return { value: loads }; },
          );
          const first = await read();
          const second = await read();
          await pluginContext.cache.invalidate('rpc/note');
          const third = await read();
          return { first, second, third, loads };
        },
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
    {
      // Raw echo: streams the request body back, reporting its byte length and
      // the value of the `x-test` header, so the host bridge is fully exercised.
      method: 'POST',
      path: '/raw/echo',
      kind: 'raw',
      handler: async (req, reply) => {
        reply.status(201);
        reply.header('x-raw', 'yes');
        let total = 0;
        const chunks = [];
        for await (const chunk of req.body) {
          chunks.push(Buffer.from(chunk));
          total += chunk.length;
        }
        const payload = Buffer.concat(chunks);
        reply.write(Buffer.from(`len=${total};hdr=${req.headers['x-test'] ?? ''};`));
        reply.write(payload);
        reply.end();
      },
    },
    {
      // Raw stream: emits `chunks` chunks of `size` bytes each, then closes. Used
      // to prove the response can exceed one IPC message without buffering.
      method: 'GET',
      path: '/raw/burst',
      kind: 'raw',
      handler: async (req, reply) => {
        reply.status(200);
        reply.header('content-type', 'application/octet-stream');
        const count = Number(req.query.get('chunks') ?? 1);
        const size = Number(req.query.get('size') ?? 1);
        const chunk = Buffer.alloc(size, 0x61);
        for (let i = 0; i < count; i += 1) reply.write(chunk);
        reply.end();
      },
    },
    {
      // Raw stream that honours backpressure: it keeps emitting until `write`
      // reports the consumer is behind, then awaits `drain()`. Used to prove the
      // bounded queue path terminates instead of growing without bound.
      method: 'GET',
      path: '/raw/drain',
      kind: 'raw',
      handler: async (req, reply) => {
        reply.status(200);
        reply.header('content-type', 'application/octet-stream');
        const count = Number(req.query.get('chunks') ?? 1);
        const size = Number(req.query.get('size') ?? 1);
        const chunk = Buffer.alloc(size, 0x62);
        let stalls = 0;
        for (let i = 0; i < count; i += 1) {
          if (reply.write(chunk) === false) {
            stalls += 1;
            await reply.drain();
          }
        }
        // Report how many times backpressure was observed, so the test can
        // assert drain() actually engaged rather than never being needed.
        reply.end(Buffer.from(`\nstalls=${stalls}`));
      },
    },
    {
      // Raw failure before any output: the host must map this to an error status.
      method: 'GET',
      path: '/raw/boom',
      kind: 'raw',
      handler: async () => {
        throw Object.assign(new Error('raw boom'), { status: 502 });
      },
    },
    {
      // Raw failure after the head is flushed: the host must abort the partial
      // response rather than emit a clean end.
      method: 'GET',
      path: '/raw/boom-late',
      kind: 'raw',
      handler: async (_req, reply) => {
        reply.status(200);
        reply.write('partial');
        throw new Error('raw late boom');
      },
    },
    {
      // Raw wait: never ends on its own; used to prove a client disconnect
      // triggers `onClientClose` and tears the handler down.
      method: 'GET',
      path: '/raw/hang',
      kind: 'raw',
      handler: async (_req, reply) => {
        reply.status(200);
        reply.onClientClose(() => {
          process.send?.({ protocol: 1, pluginId: 'isolated-rpc-test', type: 'event', token: 'raw-closed', payload: true });
        });
        await new Promise(() => undefined);
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
