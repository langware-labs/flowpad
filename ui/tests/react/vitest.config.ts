import path from 'path';
import { defineConfig, mergeConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import viteConfig from '../../vite.config';
import { HOOK_TIMEOUT_MS } from './testConstants';

// React tests include live-SDK suites (apiTestSetup, entity writes, and local
// filesystem actions). Bind both the SDK define and jsdom origin to the
// caller-owned instance instead of silently inheriting `.env.local`. The root
// Vitest config evaluates every project config, so a missing selection stays
// inert here and is rejected by reactSetup only when the React project runs.
const instanceName = process.env.FLOW_INSTANCE?.trim() || '';
const mode = instanceName || 'test';
const env = loadEnv(mode, path.resolve(__dirname, '../../..'), '');
const instanceEnvMatches = !!instanceName && env.FLOW_INSTANCE === instanceName;
const port = instanceEnvMatches && /^\d+$/.test(env.LOCAL_SERVER_PORT || '') ? env.LOCAL_SERVER_PORT : '';
const apiUrl = port && env.VITE_API_URL === `http://localhost:${port}` ? env.VITE_API_URL : '';
const resolvedViteConfig =
  typeof viteConfig === 'function' ? viteConfig({ mode, command: 'serve' } as any) : viteConfig;

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
        allow: [path.resolve(__dirname, '../..'), path.resolve(__dirname, '../../../ts_sdk')],
      },
    },
    test: {
      name: 'react',
      environment: 'jsdom',
      environmentOptions: {
        jsdom: {
          url: port ? `http://localhost:${port}` : 'http://localhost',
        },
      },
      setupFiles: [path.resolve(__dirname, '../_lingui-mock.ts'), path.resolve(__dirname, './reactSetup.ts')],
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
      __API_URL__: JSON.stringify(apiUrl),
      __REACT_INSTANCE_NAME__: JSON.stringify(instanceName),
      __REACT_BACKEND_PORT__: JSON.stringify(port),
      'process.env.NODE_ENV': '"test"',
    },
  }),
);
