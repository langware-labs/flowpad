import path from 'path';
import { defineConfig, mergeConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import viteConfig from '../../vite.config';
import { HOOK_TIMEOUT_MS } from './testConstants';

const env = loadEnv('test', path.resolve(__dirname, '../../..'), '');
const port = env.LOCAL_SERVER_PORT || '9007';
const resolvedViteConfig = typeof viteConfig === 'function' ? viteConfig({ mode: 'test', command: 'serve' } as any) : viteConfig;

export default mergeConfig(
  resolvedViteConfig,
  defineConfig({
    resolve: {
      alias: {
        '@shared-compat': path.resolve(__dirname, '../utils/shared-compat.ts'),
      },
      dedupe: ['react', 'react-dom', 'react-router', '@tanstack/react-query', 'cmdk'],
    },
    ssr: {
      noExternal: true,
    },
    server: {
      fs: {
        allow: [
          path.resolve(__dirname, '../..'),
          path.resolve(__dirname, '../../../ts_sdk'),
        ],
      },
    },
    test: {
      name: 'react',
      environment: 'jsdom',
      environmentOptions: {
        jsdom: {
          url: `http://localhost:${port}`,
        },
      },
      setupFiles: [path.resolve(__dirname, './reactSetup.ts')],
      exclude: ['**/old_flowpad_repo/**', '**/node_modules/**'],
      globals: true,
      css: false,
      hookTimeout: 15000,
      testTimeout: 15000,
      pool: 'threads',
      poolOptions: {
        threads: {
          singleThread: true,
        },
      },
      server: {
        deps: {
          inline: ['next-themes', 'react', 'react-dom', 'react-router'],
        },
      },
    },
    esbuild: {
      jsx: 'transform',
      jsxDev: false,
    },
    define: {
      'process.env.NODE_ENV': '"test"',
    },
  }),
);
