import path from 'path';
import { defineConfig, mergeConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import viteConfig from '../../vite.config';

const env = loadEnv('test', path.resolve(__dirname, '../../..'), '');
// No hardcoded port fallback — the backend port is whatever `.env.local`
// configures (LOCAL_SERVER_PORT). A wrong default (e.g. 9007) silently points
// the SDK at a non-existent backend and every hub test fails opaquely.
//
// The missing-port check is DEFERRED to `_setup.ts` (a setupFile that only
// loads when the hub project actually runs) rather than thrown here. This
// config file is `extends`-ed by the ROOT vitest config and therefore
// evaluated for EVERY project — throwing at load time broke unrelated runs
// (e.g. CI's `vitest run --project unit`, where `.env.local` is absent) before
// any test executed. The port is baked into the runtime via `define` so the
// setup can validate it; still a hard fail on a missing port, just at hub-test
// start instead of config load.
const port = env.LOCAL_SERVER_PORT;
const resolvedViteConfig = typeof viteConfig === 'function' ? viteConfig({ mode: 'test', command: 'serve' } as any) : viteConfig;

export default mergeConfig(
  resolvedViteConfig,
  defineConfig({
    // Bake the resolved backend port (or empty string when unset) into the test
    // runtime so `_setup.ts` can hard-fail a hub run that has no port — without
    // throwing here at config-eval time for unrelated projects.
    define: {
      __HUB_BACKEND_PORT__: JSON.stringify(port ?? ''),
    },
    test: {
      // Hub round-trips include local-backend → hub HTTP, hub fanout, WS bridge
      // back to the local backend, and finally to the in-test SDK. Each leg is
      // ~tens of ms; 30s budget covers a 5-message ping-pong with margin.
      testTimeout: 30000, // do not increase timeout without approval
      hookTimeout: 15000,
      // Reset the per-instance SDK realm override (__FLOWPAD_API_URL__) after
      // every file so a two-client file never leaks its backend target into a
      // subsequent single-client file (single-threaded → shared globalThis).
      setupFiles: [path.resolve(__dirname, '_setup.ts')],
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
          // Only consumed when the hub environment actually boots (i.e. hub
          // tests run, where `_setup.ts` has already asserted the port exists).
          url: port ? `http://localhost:${port}` : 'http://localhost',
        },
      },
    },
  }),
);
