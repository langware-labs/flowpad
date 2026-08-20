import path from 'path';
import { defineConfig, mergeConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import viteConfig from '../../vite.config';

// FLOW_INSTANCE selects the matching generated `.env.<name>.local`. The root
// Vitest config evaluates every project config, so missing/mismatched selection
// is hard-failed by the hub setup file only when this project actually runs.
const instanceName = process.env.FLOW_INSTANCE?.trim() || '';
const mode = instanceName || 'test';
const env = loadEnv(mode, path.resolve(__dirname, '../../..'), '');
const instanceEnvMatches = !!instanceName && env.FLOW_INSTANCE === instanceName;
const port = instanceEnvMatches ? env.LOCAL_SERVER_PORT || '' : '';
const resolvedViteConfig =
  typeof viteConfig === 'function' ? viteConfig({ mode, command: 'serve' } as any) : viteConfig;

export default mergeConfig(
  resolvedViteConfig,
  defineConfig({
    // `_setup.ts` compares these compile-time values with the synchronous
    // launcher/env identity resolution before any test can write to a backend.
    define: {
      __HUB_INSTANCE_NAME__: JSON.stringify(instanceName),
      __HUB_BACKEND_PORT__: JSON.stringify(port),
    },
    test: {
      // Hub round-trips include local-backend → hub HTTP, hub fanout, WS bridge
      // back to the local backend, and finally to the in-test SDK. Each leg is
      // ~tens of ms; 30s budget covers a 5-message ping-pong with margin.
      testTimeout: 30000, // do not increase timeout without approval
      hookTimeout: 15000,
      // Reset the per-instance SDK realm override (__FLOWPAD_API_URL__) after
      // every file so a two-client file never leaks its backend target into a
      // subsequent single-client file (single-threaded -> shared globalThis).
      setupFiles: [path.resolve(__dirname, '../_fetch_realm.ts'), path.resolve(__dirname, '_setup.ts')],
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
          // Missing selection stays origin-only until `_setup.ts` fails closed.
          url: port ? `http://localhost:${port}` : 'http://localhost',
        },
      },
    },
  }),
);
