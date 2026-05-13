import path from 'path';
import { defineConfig, mergeConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import viteConfig from '../../vite.config';

const env = loadEnv('test', path.resolve(__dirname, '../../..'), '');
const port = env.LOCAL_SERVER_PORT || '9007';
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
