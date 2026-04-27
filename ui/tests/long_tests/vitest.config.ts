import path from 'path';
import { defineConfig, mergeConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import viteConfig from '../../vite.config';

const env = loadEnv('test', path.resolve(__dirname, '../..'), '');
const port = env.LOCAL_SERVER_PORT || '9007';
const resolvedViteConfig = typeof viteConfig === 'function' ? viteConfig({ mode: 'test', command: 'serve' } as any) : viteConfig;

// Worker selection: tests construct ``new AgenticProcess({ workdir })`` with
// no explicit worker_type, so the backend's default applies. Two npm scripts
// pin this:
//   npm run test:vitest:long:claude   → FLOWPAD_DEFAULT_WORKER=claude
//   npm run test:vitest:long:codex    → FLOWPAD_DEFAULT_WORKER=codex
// The env var must be set on the BACKEND process (the Python server at
// localhost:$LOCAL_SERVER_PORT) — start it with the matching env before
// running these scripts. The same script also exports the var to the test
// runner so any in-process bootstrap can read it.

export default mergeConfig(
  resolvedViteConfig,
  defineConfig({
    test: {
      testTimeout: 240000, // 4 min — real Claude subprocess tests
      hookTimeout: 15000,
      include: ['tests/long_tests/**/*.test.{ts,tsx}', 'tests/api/**/*.test.{ts,tsx}'],
      exclude: ['**/node_modules/**'],
      pool: 'threads',
      poolOptions: {
        threads: {
          singleThread: true,
        },
      },
      reporters: ['default', 'hanging-process'],
      environment: 'jsdom',
      environmentOptions: {
        jsdom: {
          url: `http://localhost:${port}`,
        },
      },
    },
  }),
);
