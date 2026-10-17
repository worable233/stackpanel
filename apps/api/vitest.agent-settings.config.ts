import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  environment: 'node', fileParallelism: false,
  setupFiles: ['tests/agent-integration-setup.ts'],
  include: ['tests/integration/agent-settings.test.ts', 'tests/integration/agent-conversations.test.ts'],
} });
