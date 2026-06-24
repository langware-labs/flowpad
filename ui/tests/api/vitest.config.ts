import path from 'path';
import { defineConfig, mergeConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import viteConfig from '../../vite.config';

// Instance-aligned target: when FLOW_INSTANCE is set (e.g. a dedicated
// instance_ctl instance like `idxfix`), use it as the vite mode so loadEnv
// picks up `.env.<instance>.local` (its LOCAL_SERVER_PORT + VITE_API_URL) and
// the SDK's __API_URL__ define, jsdom url, and worker FLOW_INSTANCE all point
// at the SAME backend. Unset → 'test' mode → `.env.local` (default dev backend).
const mode = process.env.FLOW_INSTANCE || 'test';
const env = loadEnv(mode, path.resolve(__dirname, '../../..'), '');
const port = env.LOCAL_SERVER_PORT || '9007';
const resolvedViteConfig = typeof viteConfig === 'function' ? viteConfig({ mode, command: 'serve' } as any) : viteConfig;

export default mergeConfig(
  resolvedViteConfig,
  defineConfig({
    test: {
      testTimeout: 15000, // Increased timeout for compute node tests
      hookTimeout: 15000, // Increased hook timeout for API setup with websockets
      setupFiles: [path.resolve(__dirname, './apiSetup.ts')],
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
