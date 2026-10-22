import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** Root ESLint 9/10 flat config shared across all packages.
 *  Apps may extend this (e.g. Next.js app adds eslint-config-next).
 *  @param extraIgnores extra ignore patterns beyond the defaults.
 */
export function baseConfig(extraIgnores = []) {
  return tseslint.config(
    {
      ignores: [
        '**/node_modules/**',
        '**/dist/**',
        '**/build/**',
        '**/.next/**',
        '**/coverage/**',
        // Runtime data directories (gitignored): databases, uploaded media,
        // local probe scripts. Never source.
        '**/data/**',
        ...extraIgnores,
      ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
      // Node globals apply to every file kind, not just TS: plain `.mjs`
      // fixtures and scripts are linted too.
      languageOptions: {
        globals: { ...globals.node },
      },
    },
    {
      files: ['**/*.{ts,tsx}'],
      languageOptions: {
        globals: { ...globals.node },
      },
      rules: {
        '@typescript-eslint/no-explicit-any': 'error',
        '@typescript-eslint/no-unused-vars': [
          'error',
          { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
        ],
        '@typescript-eslint/no-non-null-assertion': 'error',
        '@typescript-eslint/consistent-type-imports': 'error',
      },
    },
    {
      files: ['**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}'],
      rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
    },
    {
      files: ['**/*.mjs'],
      languageOptions: { globals: { ...globals.node } },
    },
  );
}

export default baseConfig();
