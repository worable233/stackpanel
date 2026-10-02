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
        ...extraIgnores,
      ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
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
  );
}

export default baseConfig();
