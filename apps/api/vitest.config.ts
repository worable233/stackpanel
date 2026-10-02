import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    // Integration tests toggle the same plugin ids in a shared DB; run test
    // files serially so their enabled-state expectations never race.
    fileParallelism: false,
  },
});
