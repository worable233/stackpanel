import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/client.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  dts: true,
  external: [
    '@prisma/client',
    '@prisma/client/runtime/*',
    '@prisma/adapter-pg',
    'pg',
    'ioredis',
    '@aws-sdk/client-s3',
    '@aws-sdk/s3-request-presigner',
  ],
});
