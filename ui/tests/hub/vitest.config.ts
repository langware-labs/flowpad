import path from 'path';
import { defineConfig, mergeConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import viteConfig from '../../vite.config';

const env = loadEnv('test', path.resolve(__dirname, '../../..'), '');
// No hardcoded port fallback — the backend port is whatever `.env.local`
// configures (LOCAL_SERVER_PORT). A wrong default (e.g. 9007) silently points
// the SDK at a non-existent backend and every hub test fails opaquely.
const port = env.LOCAL_SERVER_PORT;
if (!port) {
  throw new Error('hub vitest: LOCAL_SERVER_PORT is not set in .env.local — refusing to guess a backend port');
}
const resolvedViteConfig = typeof viteConfig === 'function' ? viteConfig({ mode: 'test', command: 'serve' } as any) : viteConfig;

export default mergeConfig(
  resolvedViteConfig,
  defineConfig({
    test: {
      // Hub round-trips include local-backend → hub HTTP, hub fanout, WS bridge
      // back to the local backend, and finally to the in-test SDK. Each leg is
      // ~tens of ms; 30s budget covers a 5-message ping-pong with margin.
      testTimeout: 30000, // do not increase timeout without approval
      hookTimeout: 15000,
      // Reset the per-instance SDK realm override (__FLOWPAD_API_URL__) after
      // every file so a two-client file never leaks its backend target into a
      // subsequent single-client file (single-threaded → shared globalThis).
      setupFiles: [path.resolve(__dirname, '_setup.ts')],
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
