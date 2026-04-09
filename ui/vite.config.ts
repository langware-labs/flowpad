import react from '@vitejs/plugin-react-swc';
import path from 'path';
import { defineConfig, loadEnv } from 'vite';

const envDir = path.resolve(__dirname, '..');

export default defineConfig(({ mode }) => {
  const env = { ...process.env, ...loadEnv(mode, envDir, '') };
  const isPackage = env.DEPLOY_ENV === 'desktop' && env.IS_PACKAGE;

  return {
    envDir,
    base: '/',
    define: {
      __API_URL__: JSON.stringify(env.VITE_API_URL || (isPackage ? '' : `http://localhost:${env.LOCAL_SERVER_PORT || '9007'}`)),
      __AUTH_PROVIDER__: JSON.stringify(env.AUTH_PROVIDER || 'local'),
      __DEPLOY_ENV__: JSON.stringify(env.DEPLOY_ENV || 'local'),
      __IS_PACKAGE__: JSON.stringify(!!isPackage),
    },
    build: {
      sourcemap: true,
      outDir: 'dist',
    },
    plugins: [
      react({
        tsDecorators: true,
      }),
    ],
    server: {
      host: 'localhost',
      port: parseInt(env.VITE_PORT || '4097'),
      proxy: {
        '/api/v1/notify': `http://localhost:${env.LOCAL_SERVER_PORT || '9007'}`,
      },
      fs: {
        allow: [
          path.resolve(__dirname, './'),
          path.resolve(__dirname, '../ts_sdk'),
          path.resolve(env.HOME || '~', 'pty_sync/src/pty-sync'),
        ],
      },
      warmup: {
        clientFiles: ['./src/main.tsx', './src/**/*.tsx', './src/!(test)/**/*.ts'],
      },
    },
    optimizeDeps: {
      exclude: ['playwright-core', 'playwright'],
      include: [
        'axios',
        '@sentry/browser',
        'uuid',
        'immer',
        'mobx',
        'mobx-utils',
        '@msgpack/msgpack',
        'zustand',
        'zustand/middleware',
        'zustand/middleware/immer',
        'zustand/vanilla',
        'events',
        'eventsource-parser',
        'http-status-codes',
        'cytoscape',
        'best-effort-json-parser',
        'yaml',
      ],
    },
    resolve: {
      preserveSymlinks: true,
      alias: {
        '@src': path.resolve(__dirname, './src'),
        '@sdk': path.resolve(__dirname, '../ts_sdk/src'),
      },
      dedupe: [
        'react',
        'react-dom',
        'react-router',
        '@tanstack/react-query',
        'zustand',
        'axios',
        'mobx',
        'immer',
        '@sentry/browser',
        '@msgpack/msgpack',
        'uuid',
        'events',
        'eventsource-parser',
        'http-status-codes',
        'cytoscape',
        'best-effort-json-parser',
        'mobx-utils',
        'yaml',
      ],
    },
  };
});
