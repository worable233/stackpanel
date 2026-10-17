// Isolated-plugin fixture: registers a `storage.provider` that uses the *proxy*
// byte channel (`writeChunk`/`readChunk`) rather than spool/redirect.
//
// This is the hard case for the control-plane/byte-plane split: the bytes
// genuinely flow through the isolated worker, so this proves the kernel streams
// a large object to the plugin in bounded chunks (each under the 1 MiB IPC cap)
// and pulls it back the same way. The provider buffers in the worker and mirrors
// to `pluginContext.manifest.storageRoot` so the test can assert where the
// bytes landed.

import { writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

let pluginContext;

function rootPath(key) {
  return join(pluginContext.manifest.storageRoot, key);
}

export default {
  routes: [{ method: 'GET', path: '/probe', handler: async () => ({ ok: true }) }],
  onActivate(ctx) {
    pluginContext = ctx;
    const objects = new Map();

    ctx.registerExtension('storage.provider', {
      id: 'isolated.storage.proxy',
      name: '隔离图床',
      byteMode: 'proxy',
      async beginPut(input) {
        objects.set(input.key, { chunks: [], size: input.size, contentType: input.contentType });
        return { proxy: true };
      },
      async writeChunk(input) {
        const entry = objects.get(input.key) ?? { chunks: [], size: input.size };
        entry.chunks.push(Buffer.from(input.data));
        objects.set(input.key, entry);
      },
      async commitPut({ key }) {
        const entry = objects.get(key);
        if (!entry) return;
        const data = Buffer.concat(entry.chunks);
        const target = rootPath(key);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, data);
      },
      async abortPut({ key }) {
        objects.delete(key);
      },
      async prepareGet() {
        return { proxy: true };
      },
      async readChunk(input) {
        const buffer = await readFile(rootPath(input.key)).catch(() => null);
        if (!buffer) return null;
        return new Uint8Array(buffer.subarray(input.offset, input.offset + input.length));
      },
      async delete(key) {
        objects.delete(key);
        await rm(rootPath(key), { force: true });
      },
      async exists(key) {
        return (await readFile(rootPath(key)).catch(() => null)) !== null;
      },
      async stat(key) {
        const buffer = await readFile(rootPath(key)).catch(() => null);
        return buffer ? { key, size: buffer.length } : null;
      },
      async list() {
        return [];
      },
      url(key) {
        return `/isolated-storage-proxy/${key}`;
      },
      async ping() {
        return true;
      },
    });
  },
};
