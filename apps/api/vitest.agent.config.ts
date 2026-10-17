import { defineConfig } from 'vitest/config';

/** No database reset: pure runtime/policy tests only. */
export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    include: [
      'tests/unit/agent-runtime.test.ts',
      'tests/unit/agent-policy.test.ts',
      'tests/unit/isolated-rpc.test.ts',
      'tests/unit/agent-transport.test.ts',
      'tests/unit/agent-external.test.ts',
      'tests/unit/contract-snapshot.test.ts',
      'tests/unit/llm-provider.test.ts',
    ],
  },
});
