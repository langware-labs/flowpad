import path from 'path';
import { defineConfig, mergeConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import viteConfig from '../../vite.config';

const env = loadEnv('test', path.resolve(__dirname, '../..'), '');
const port = env.LOCAL_SERVER_PORT || '9007';
const resolvedViteConfig = typeof viteConfig === 'function' ? viteConfig({ mode: 'test', command: 'serve' } as any) : viteConfig;

export default mergeConfig(
  resolvedViteConfig,
  defineConfig({
    test: {
      testTimeout: 15000, // Increased timeout for compute node tests
      hookTimeout: 15000, // Increased hook timeout for API setup with websockets
      exclude: [],
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
