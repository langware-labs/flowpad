import react from '@vitejs/plugin-react-swc';
import { lingui } from '@lingui/vite-plugin';
import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import { SHARED_DEDUPE, sdkVersion, sharedAliases } from './vite.shared';

const envDir = path.resolve(__dirname, '..');

export default defineConfig(({ mode }) => {
  const env = { ...process.env, ...loadEnv(mode, envDir, '') };
  const isPackage = env.DEPLOY_ENV === 'desktop' && env.IS_PACKAGE;

  return {
    envDir,
    base: '/',
    define: {
      __API_URL__: JSON.stringify(
        env.VITE_API_URL || (isPackage ? '' : `http://localhost:${env.LOCAL_SERVER_PORT || '9007'}`),
      ),
      __AUTH_PROVIDER__: JSON.stringify(env.AUTH_PROVIDER || 'local'),
      __DEPLOY_ENV__: JSON.stringify(env.DEPLOY_ENV || 'local'),
      __IS_PACKAGE__: JSON.stringify(!!isPackage),
      // dev mode is a runtime localStorage flag — see dev-mode-context.tsx.
      // Don't bake it into the bundle; that turned every published wheel into
      // a dev-mode-on artifact regardless of the user's runtime.
      __CHECK_REFRESH_TOKEN__: JSON.stringify(env.VITE_CHECK_REFRESH_TOKEN === 'true'),
      __UI_VERSION__: JSON.stringify(sdkVersion(envDir)),
    },
    build: {
      sourcemap: true,
      outDir: 'dist',
    },
    plugins: [
      react({
        tsDecorators: true,
        // Lingui macro transform. `@lingui/core/macro` (t, msg, plural…) and
        // `@lingui/react/macro` (<Trans/>, useLingui) compile away to runtime
        // calls + message ids at build time — this SWC plugin performs that
        // transform (the babel-macro path is not used with plugin-react-swc).
        plugins: [['@lingui/swc-plugin', {}]],
      }),
      // Compiles `*.po` catalogs to runtime messages on import so
      // `import { messages } from './locales/<locale>/messages.po'` works in
      // dev and build without a separate `lingui compile` step in dev.
      lingui(),
      // Workaround for radix-ui/primitives#3799 / #3675: bundled @radix-ui/react-slot
      // calls composeRefs(forwardedRef, childrenRef) inline every render, producing a
      // new ref function each render. Under render storms (e.g. terminal PTY chunk
      // replay), React detach+attach fires Tooltip's setTrigger 2x per Tooltip per
      // render, eventually tripping React's 50-deep nested-update guard ("Maximum
      // update depth exceeded"). PR radix-ui/primitives#3835 memoizes via useMemo —
      // not yet released. Patch on the fly until it ships.
      {
        name: 'patch-radix-slot-memoize-composerefs',
        enforce: 'pre' as const,
        transform(code: string, id: string) {
          if (!/@radix-ui\/react-slot\/dist\/index\.m?js$/.test(id)) return null;
          if (!code.includes('composeRefs(forwardedRef, childrenRef)')) return null;
          const patched = code.replace(
            /props2\.ref = forwardedRef \? composeRefs\(forwardedRef, childrenRef\) : childrenRef;/,
            'props2.ref = React.useMemo(' +
              '() => forwardedRef ? composeRefs(forwardedRef, childrenRef) : childrenRef, ' +
              '[forwardedRef, childrenRef]' +
              ');',
          );
          return patched === code ? null : { code: patched, map: null };
        },
      },
    ],
    server: {
      host: 'localhost',
      port: parseInt(env.VITE_PORT || '4097'),
      strictPort: true,
      watch: {
        // Playwright writes traces under the UI tree; they are evidence, not source.
        ignored: ['**/tests/manual_regression/_results/**'],
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
      // Skill-UI iframes (AppHost) load from this origin and call relative
      // `/api/*` URLs from inside the sandbox. In Electron/wheel this is
      // same-origin with the backend (no proxy needed); in `npm run dev` the
      // backend is on a different port, so proxy it here.
      // The proxy is NOT optional in dev, and VITE_API_URL is the wrong switch
      // for it. That variable steers the SPA's own XHRs, which are absolute and
      // therefore never touch this server. It cannot steer a BROWSER
      // NAVIGATION -- and the hub's login redirect is exactly that: an
      // app-origin `<app_url>/api/v1/login` (authorizer._login_url_back_to).
      //
      // With the proxy off, that navigation landed on the SPA router, which
      // re-rendered, found no session, and redirected to login again -- wrapping
      // the previous url into `target_path` each pass. A redirect loop with an
      // address growing one encoding layer at a time, not the "Page not found"
      // the old comment predicted.
      //
      // So: always proxy, and let VITE_API_URL choose the TARGET. One knob
      // ("which hub am I talking to?") instead of two that could disagree.
      proxy: (() => {
        const target = env.VITE_API_URL || `http://localhost:${env.LOCAL_SERVER_PORT || '9007'}`;
        return {
          // Derived from the same value so the two can never skew: http -> ws,
          // https -> wss.
          '/api/v1/connect/ws': {
            target: target.replace(/^http/, 'ws'),
            ws: true,
            changeOrigin: true,
          },
          // changeOrigin rewrites Host, which a remote hub behind a vhost
          // requires and a localhost one does not mind.
          '/api': {
            target,
            changeOrigin: true,
          },
        };
      })(),
    },
    optimizeDeps: {
      exclude: ['playwright-core', 'playwright'],
      include: [
        'axios',
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
        ...sharedAliases(__dirname),
        // @xterm/headless 6.0.0 declares module:"lib/xterm.mjs" but ships
        // lib-headless/xterm-headless.mjs — Node resolves via main, Vite via
        // module and fails. Point straight at the shipped ESM build.
        '@xterm/headless': path.resolve(__dirname, 'node_modules/@xterm/headless/lib-headless/xterm-headless.mjs'),
      },
      dedupe: SHARED_DEDUPE,
    },
  };
});
