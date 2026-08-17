import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import { SHARED_DEDUPE, sdkVersion, sharedAliases } from './vite.shared';

/**
 * Builds the ts_sdk as a standalone library for `/sdk/flowpad-sdk.js`.
 *
 * It lives here, not in ts_sdk/, because ts_sdk has no toolchain of its own —
 * no build script and no devDependencies; its own vite.config.ts is vestigial
 * from when the package was published separately. `ui` already has vite and
 * already resolves `@sdk`, so building from here costs nothing instead of
 * standing up a second dependency tree that would then have to be kept in step.
 *
 * The bundle is what a served app imports. It deliberately does NOT bake an API
 * URL: `load_config` honours `globalThis.__FLOWPAD_API_URL__` above the
 * compile-time define, and the backend injects that as its own origin into
 * every HTML document it serves — so one bundle is correct on every instance,
 * local or cloud.
 */
const envDir = path.resolve(__dirname, '..');

export default defineConfig(({ mode }) => {
  const env = { ...process.env, ...loadEnv(mode, envDir, '') };

  return {
    envDir,
    // A library build has no public assets. Left at the default, vite copies
    // all of ui/public/ (favicon, email-verification.html, …) into the output
    // and they end up shadowing real static files under /sdk.
    publicDir: false as const,
    define: {
      // The bundle runs in a plain browser page with no bundler shim around
      // it, so every `process.*` reference must be substituted at build time or
      // importing it dies on `ReferenceError: process is not defined` before a
      // single export is reachable.
      'process.env.NODE_ENV': JSON.stringify('production'),
      'process.env': '{}',
      __API_URL__: JSON.stringify(''),
      __AUTH_PROVIDER__: JSON.stringify(env.AUTH_PROVIDER || 'local'),
      __DEPLOY_ENV__: JSON.stringify(env.DEPLOY_ENV || 'local'),
      __IS_PACKAGE__: JSON.stringify(true),
      __CHECK_REFRESH_TOKEN__: JSON.stringify(false),
      __FLOWPAD_APP_HOST__: JSON.stringify(env.MICRO_APP_DOMAIN_CONFIG__APP_DOMAIN || 'flowpad.app'),
      __FLOWPAD_APP_PORT__: JSON.stringify(env.MICRO_APP_DOMAIN_CONFIG__PORT || ''),
      __UI_VERSION__: JSON.stringify(sdkVersion(envDir)),
    },
    resolve: {
      preserveSymlinks: true,
      alias: sharedAliases(__dirname),
      // ts_sdk has no node_modules of its own, so a bare import inside
      // ts_sdk/src/ has nothing to resolve against walking upward. `dedupe`
      // makes vite resolve these from THIS project root instead — the same
      // mechanism that lets the main ui build bundle the same sources.
      dedupe: SHARED_DEDUPE,
    },
    build: {
      outDir: path.resolve(__dirname, 'sdk-dist'),
      emptyOutDir: true,
      sourcemap: true,
      lib: {
        entry: path.resolve(__dirname, '../ts_sdk/src/index.ts'),
        name: 'FlowpadSdk',
        fileName: 'flowpad-sdk',
        formats: ['es', 'umd'],
      },
      rollupOptions: {
        // React is a peer concern of the SDK's optional react/ helpers; an app
        // that doesn't use them should not pay for a bundled React, and one
        // that does brings its own.
        external: ['react', 'react-dom', 'react/jsx-runtime'],
        output: {
          globals: {
            react: 'React',
            'react-dom': 'ReactDOM',
            'react/jsx-runtime': 'jsxRuntime',
          },
        },
      },
    },
  };
});
