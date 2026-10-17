import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    '.next/**',
    // Next build output kept for comparison by the performance / spike sessions.
    '.next-spike*/**',
    '.next-bt/**',
    // Local-only spike harness artifacts (gitignored, see .gitignore).
    '.spike-artifacts/**',
    'src/app/(spike)/**',
    'spike/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    'data/**',
  ]),
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
]);

export default eslintConfig;
