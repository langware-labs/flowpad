import path from 'path';
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from '../../vite.config';

const resolvedViteConfig = typeof viteConfig === 'function' ? viteConfig({ mode: 'test', command: 'serve' } as any) : viteConfig;

export default mergeConfig(
  resolvedViteConfig,
  defineConfig({
    resolve: {
      alias: {
        '@shared-compat': path.resolve(__dirname, '../utils/shared-compat.ts'),
      },
    },
    test: {
      hookTimeout: 15000,
      testTimeout: 15000,
      environment: 'jsdom',
      setupFiles: ['./tests/unit/testSetup.ts'],
      pool: 'threads',
      poolOptions: {
        threads: {
          singleThread: true,
        },
      },
    },
  }),
);
