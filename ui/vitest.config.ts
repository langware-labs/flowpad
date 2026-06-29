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
      {
        // Headless tests: boot the REAL full app in jsdom + RTL against a LIVE
        // backend (no mocks) — the in-process E2E tier. Skip themselves when no
        // backend is reachable, so they're kept out of the default `test` chain
        // and run on demand / in the e2e-qa cycle.
        extends: './tests/headless/vitest.config.ts',
        test: {
          name: 'headless',
          include: ['tests/headless/**/*.test.{ts,tsx}'],
        },
      },
      {
        extends: './tests/hub/vitest.config.ts',
        test: {
          name: 'hub',
          include: ['tests/hub/**/*.test.{ts,tsx}'],
          // Two-PROCESS protocol tests: each is one half of a concurrent pair
          // (alice ↔ bob via a rendezvous file) and can never pass in a
          // sequential single-process run — alice waits for a bob that hasn't
          // started. Run them via scripts/run_hub_paired.sh, which launches
          // both halves concurrently against their own backends.
          exclude: [
            '**/node_modules/**',
            '**/matrix.alice.test.ts',
            '**/matrix.bob.test.ts',
            '**/conversation_messages.test.ts',
            '**/conversation_messages.bob.test.ts',
          ],
        },
      },
      {
        extends: './tests/hub/vitest.config.ts',
        test: {
          name: 'hub-paired',
          // The two-process pair halves (see the hub project's exclude note).
          include: [
            'tests/hub/matrix.alice.test.ts',
            'tests/hub/matrix.bob.test.ts',
            'tests/hub/conversation_messages.test.ts',
            'tests/hub/conversation_messages.bob.test.ts',
          ],
        },
      },
    ],
  },
});
