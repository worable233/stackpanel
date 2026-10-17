// Isolated-plugin fixture: registers a `storage.provider` on the kernel.
//
// Every provider method delegates to the kernel capability
// `ctx.storage.backend(...)`, so the real byte/presign machinery stays in the
// kernel while the worker only holds a *remote* proxy (ADR-0014 extension,
// ADR-0008 boundary). The root comes from the manifest so the test can assert
// where the bytes actually landed.

let pluginContext;

function localBackend() {
  const root = pluginContext.manifest.storageRoot;
  return pluginContext.storage.backend({ driver: 'local', root });
}

export default {
  routes: [{ method: 'GET', path: '/probe', handler: async () => ({ ok: true }) }],
  onActivate(ctx) {
    pluginContext = ctx;
    ctx.registerExtension('storage.provider', {
      id: 'isolated.storage',
      name: '隔离存储',
      // Nominal only: the kernel infers the channel from `beginPut`'s return.
      byteMode: 'spool',
      async beginPut(input) {
        return (await localBackend()).beginPut(input);
      },
      async prepareGet(key) {
        return (await localBackend()).prepareGet(key);
      },
      async delete(key) {
        return (await localBackend()).delete(key);
      },
      async exists(key) {
        return (await localBackend()).exists(key);
      },
      async stat(key) {
        return (await localBackend()).stat(key);
      },
      async list(prefix) {
        return (await localBackend()).list(prefix);
      },
      url(key) {
        return `/isolated-storage/${key}`;
      },
      async ping() {
        return true;
      },
    });
  },
};
