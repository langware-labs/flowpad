import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        extends: './tests/unit/vitest.config.ts',
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.{ts,tsx}'],
        },
      },
      {
        extends: './tests/api/vitest.config.ts',
        test: {
          name: 'api',
          include: ['tests/api/**/*.test.{ts,tsx}'],
        },
      },
      {
        extends: './tests/react/vitest.config.ts',
        test: {
          name: 'react',
          include: ['tests/react/**/*.test.{ts,tsx}'],
        },
      },
      {
        extends: './tests/long_tests/vitest.config.ts',
        test: {
          name: 'long',
          include: ['tests/long_tests/**/*.test.{ts,tsx}'],
        },
      },
    ],
  },
});
