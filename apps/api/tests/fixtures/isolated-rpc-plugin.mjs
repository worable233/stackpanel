import { z } from 'zod';

let pluginContext;
const model = {
  kind: 'rpc/note',
  label: 'RPC note',
  schema: z.object({ title: z.string() }),
  indexes: [{ fields: ['title'], types: { title: 'string' } }],
};

/**
 * 类实例形式的扩展实现：宿主通过 workerProxy 回调时必须保留 receiver，
 * 否则内部访问 this.xxx 会抛 "Cannot read properties of undefined"。
 * 对象字面量风格看不出这个差异，所以夹具固定用类。
 */
class ProbeExtension {
  constructor() {
    this.id = 'rpc-extension';
    this.calls = 0;
  }

  async run(value) {
    this.calls += 1;
    return `${value}:${this.calls}`;
  }
}

export default {
  routes: [
    { method: 'GET', path: '/probe', handler: async () => ({ ok: true }) },
    {
      // A plugin-declared failure: the code/status/detail must survive the IPC
      // boundary *and* be recognisable again (`isPluginError`) on the host side.
      method: 'GET',
      path: '/error-status',
      handler: async () => {
        const error = new Error('probe.invalid');
        error.code = 'probe.invalid';
        error.status = 409;
        error.detail = '冲突：状态不允许';
        throw error;
      },
    },
    {
      // A plugin-local error class may carry only a status (`statusCode`) and no
      // stable code — the zjmf provider does exactly that. The kernel must still
      // honour the status; requiring a code demoted this refusal to a 500.
      method: 'GET',
      path: '/error-status-only',
      handler: async () => {
        const error = new Error('缺少原请求的持久化账单证据，禁止通过人工声明重开');
        error.status = 409;
        throw error;
      },
    },
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
        // 契约探针：SDK 声明为同步的方法在 isolated 下必须真的同步返回。
        // 旧缺陷里它们经 callHost 变成 Promise（恒真），`if (!x.isAvailable())`
        // 这类守卫直接失效。这里把「是不是 Promise」本身当断言值返回。
        method: 'GET',
        path: '/sync-contract',
        handler: async () => {
          const probe = (value) => ({
            isPromise: typeof value?.then === 'function',
            value: typeof value?.then === 'function' ? null : value,
          });
          return {
            secrets: probe(pluginContext.secrets.isAvailable()),
            captchaMode: probe(pluginContext.captcha.mode()),
            captchaConfigured: probe(pluginContext.captcha.isConfigured()),
            captchaProviders: probe(pluginContext.captcha.providerIds()),
            requiresVerification: probe(pluginContext.identity.requiresEmailVerification()),
            deliveryConfigured: probe(pluginContext.identity.isDeliveryConfigured()),
            senders: probe(pluginContext.identity.senderIds()),
            providerModes: probe(pluginContext.payments.providerModes()),
            declared: probe(pluginContext.notificationPolicy.declares('order.paid')),
            undeclared: probe(pluginContext.notificationPolicy.declares('nope.unregistered')),
            wildcard: probe(pluginContext.notificationPolicy.declares('agent.run.done')),
          };
        },
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
        // W4: exercise `ctx.events.publish` (RPC failures must not be silent)
        // and `ctx.events.intercept` (must throw a clear "unsupported" error).
        method: 'GET',
        path: '/events-publish',
        handler: async () => {
          pluginContext.events.publish('probe.published', { v: 1 });
          return { ok: true };
        },
      },
      {
        method: 'GET',
        path: '/events-intercept',
        handler: async () => {
          const errors = {};
          try {
            pluginContext.events.intercept('probe.waterfall', (value) => value);
          } catch (error) {
            errors.intercept = error instanceof Error ? error.message : String(error);
          }
          try {
            pluginContext.events.waterfall('probe.waterfall', 1, (value) => value);
          } catch (error) {
            errors.waterfall = error instanceof Error ? error.message : String(error);
          }
          return errors;
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
      // Kernel storage capability: the worker must receive a *remote* provider
      // proxy (methods re-issued as `storage.invoke`), never the kernel driver.
      method: 'GET',
      path: '/storage',
      handler: async () => {
        const provider = await pluginContext.storage.backend({
          driver: 'local',
          root: '/tmp/isolated-storage',
        });
        const target = await provider.beginPut({
          key: 'media/2026/01/a/original.png',
          size: 3,
          contentType: 'image/png',
        });
        const stat = await provider.stat('media/2026/01/a/original.png');
        return { id: provider.id, byteMode: provider.byteMode, target, stat };
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
    ctx.registerExtension('probe.extension', new ProbeExtension());
  },
};
