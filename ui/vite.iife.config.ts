/**
 * IIFE SDK build — produces a self-contained flowpad-sdk.js that any HTML
 * page can load with a plain <script> tag from http://localhost:9007/sdk/flowpad-sdk.js.
 *
 * Usage:
 *   cd ui && npx vite build --config vite.iife.config.ts
 *
 * Output:
 *   flow_sdk/server/static/sdk/flowpad-sdk.js
 */

import { createRequire } from 'module';
import path from 'path';
import { defineConfig } from 'vite';

const _require = createRequire(path.resolve(__dirname, 'package.json'));

export default defineConfig({
  resolve: {
    alias: {
      // Force browser builds — avoids pulling in Node-only deps (stream, crypto, etc.)
      axios: path.resolve(__dirname, 'node_modules/axios/dist/browser/axios.cjs'),
      uuid: path.resolve(__dirname, 'node_modules/uuid/dist/cjs-browser/index.js'),
      // Node's built-in 'events' isn't available in the browser — use the polyfill
      events: path.resolve(__dirname, 'node_modules/events/events.js'),
    },
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    // SDK connects to the local backend by default
    __API_URL__: JSON.stringify('http://localhost:9007'),
    __API_URL_WL__: JSON.stringify(''),
    __AUTH_PROVIDER__: JSON.stringify('local'),
    __DEPLOY_ENV__: JSON.stringify('local'),
    __SENTRY_DSN__: JSON.stringify(''),
    __SENTRY_PROJECT__: JSON.stringify(''),
    __FLOWPAD_APP_HOST__: JSON.stringify(''),
    __FLOWPAD_APP_PORT__: JSON.stringify(''),
    __APP_VERSION__: JSON.stringify('0.0.0-iife'),
  },
  // Don't copy ui/public/ into the SDK output
  publicDir: false,
  build: {
    outDir: path.resolve(__dirname, '../flow_sdk/server/static/sdk'),
    emptyOutDir: false,
    lib: {
      entry: path.resolve(__dirname, '../ts_sdk/src/index.ts'),
      name: 'FlowpadSdk',
      fileName: () => 'flowpad-sdk.js',
      formats: ['iife'],
    },
    rollupOptions: {
      // Bundle everything — React, ReactDOM, axios, etc. — no externals
      external: [],
      plugins: [
        {
          // Resolve bare imports to ui/node_modules (ts_sdk has no node_modules).
          // Vite aliases above take precedence, so axios → browser build before this runs.
          name: 'resolve-from-ui-node-modules',
          resolveId(id: string) {
            if (id.startsWith('.') || id.startsWith('/') || id.startsWith('\0')) return null;
            try {
              return _require.resolve(id);
            } catch {
              return null;
            }
          },
        },
      ],
    },
    minify: false,
    sourcemap: false,
  },
});
