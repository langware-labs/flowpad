import path from 'path';
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from '../../vite.config';

const resolvedViteConfig = typeof viteConfig === 'function' ? viteConfig({ mode: 'test', command: 'serve' } as any) : viteConfig;

export default mergeConfig(
  resolvedViteConfig,
  defineConfig({
    resolve: {
      alias: {
      },
    },
    test: {
      hookTimeout: 15000,
      testTimeout: 15000,
      // jsdom + the fetch/abort realm bridge — see the file header.
      environment: path.resolve(__dirname, '../_jsdomNodeAbort.ts'),
      setupFiles: ['./tests/_lingui-mock.ts', './tests/unit/testSetup.ts'],
      pool: 'threads',
      poolOptions: {
        threads: {
          singleThread: true,
        },
      },
    },
  }),
);
