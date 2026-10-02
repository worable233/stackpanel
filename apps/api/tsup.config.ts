import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts', 'src/worker.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  external: [
    '@prisma/client',
    '@prisma/client/runtime/*',
    '@prisma/adapter-pg',
    'pg',
    'ioredis',
    // Native libvips binding: prebuilt binaries are resolved from node_modules
    // at runtime; the module must never be bundled.
    'sharp',
    '@aws-sdk/client-s3',
    '@aws-sdk/s3-request-presigner',
    // OTel uses runtime module patching (require-in-the-middle); keep it out of
    // the bundle so instrumentation resolves from node_modules at runtime.
    '@opentelemetry/*',
    'prom-client',
  ],
});
