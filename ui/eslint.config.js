import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist',
      '**/*.css',
      '**/*.html',
      '**/*.json',
      '**/*.{png,jpg,jpeg,gif,svg,ico,webp}',
      '**/*.md',
      '**/*.{zip,tsbuildinfo}',
      'tailwind.config.ts',
      'vite.config.ts',
      'vite.sdk.config.ts',
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        // Both projects, or nothing under `tests/` can be linted at all:
        // tsconfig.app.json includes only `src` + the SDK, so every test file
        // fails type-aware linting with "not found in any of the provided
        // projects". tests/tsconfig.json already exists and is referenced from
        // tsconfig.json — it just was never handed to ESLint.
        project: ['./tsconfig.app.json', './tests/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/unbound-method': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
);
