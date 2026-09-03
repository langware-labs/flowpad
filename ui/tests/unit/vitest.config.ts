import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from '../../vite.config';

const resolvedViteConfig = typeof viteConfig === 'function' ? viteConfig({ mode: 'test', command: 'serve' } as any) : viteConfig;

export default mergeConfig(
  resolvedViteConfig,
  defineConfig({
    // The tier's backend is NOWHERE, and that is the contract (`testSetup.ts`:
    // "fully mocked — no live POSTs"). Inheriting the app's define pointed every
    // unit test at `localhost:${LOCAL_SERVER_PORT || 9007}`, so on a machine
    // running a dev instance the SDK really reached it: `TabManager`'s initial
    // refresh fetched that instance's `list_all` and REPLACED the tabs a test
    // had just installed, dropping `TabbedTerminal` onto its no-tabs branch and
    // into a component tree the test never mocked. The tier then passed or
    // failed depending on whose backend was up and what was in it.
    //
    // Address-family literal, not a port nobody is using: `.invalid` is reserved
    // by RFC 6761 and never resolves, so a request fails immediately and locally
    // instead of waiting on a connect. A unit test that WANTS a backend belongs
    // in the api tier, which resolves one properly.
    define: {
      __API_URL__: JSON.stringify('http://unit-tier-has-no-backend.invalid'),
    },
    resolve: {
      alias: {
      },
    },
    test: {
      hookTimeout: 15000,
      testTimeout: 15000,
      environment: 'jsdom',
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
