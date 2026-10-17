import { defineConfig } from 'vitest/config';
// This suite uses injected fakes only; never run the DB-reset integration setup.
export default defineConfig({ test: { include: ['tests/unit/user-detail.test.ts', 'tests/unit/user-list.test.ts'], environment: 'node' } });
