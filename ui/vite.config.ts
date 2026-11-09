import react from '@vitejs/plugin-react-swc';
import { lingui } from '@lingui/vite-plugin';
import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import { SHARED_DEDUPE, sdkVersion, sharedAliases } from './vite.shared';
import crypto from 'crypto';
import type { Plugin } from 'vite';

// HUB_LOGIN=1: sign this dev server in to the remote hub (PROXY_TARGET) the way the desktop does -- the hub's own
// OAuth (PKCE, loopback redirect). The browser's /api/v1/login is answered here; the session token lives only in
// this process's memory and rides every proxied request as a bearer. Nothing is written to disk.
const hubSession: { token?: string } = {};
function hubLoginPlugin(target: string): Plugin {
  const pending = new Map<string, { verifier: string; next: string }>();
  return {
    name: 'flowpad-hub-login',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url || '/', `http://${req.headers.host}`);
        const redirectUri = `http://${req.headers.host}/__hub_login/callback`;
        if (url.pathname === '/api/v1/login') {
          const verifier = crypto.randomBytes(32).toString('base64url');
          const state = crypto.randomBytes(16).toString('base64url');
          pending.set(state, { verifier, next: url.searchParams.get('target_path') || '/dock/hub/home' });
          const q = new URLSearchParams({
            client_id: 'flowpad-desktop',
            response_type: 'code',
            redirect_uri: redirectUri,
            state,
            code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
            code_challenge_method: 'S256',
          });
          res.writeHead(302, { location: `${target}/api/v1/oauth/authorize?${q}` });
          return res.end();
        }
        if (url.pathname === '/__hub_login/callback') {
          const got = pending.get(url.searchParams.get('state') || '');
          pending.delete(url.searchParams.get('state') || '');
          if (!got || !url.searchParams.get('code')) {
            res.writeHead(400, { 'content-type': 'text/plain' });
            return res.end(`hub login failed: ${url.searchParams.get('error_description') || 'bad state'}`);
          }
          const r = await fetch(`${target}/api/v1/oauth/token`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'authorization_code',
              code: url.searchParams.get('code')!,
              redirect_uri: redirectUri,
              client_id: 'flowpad-desktop',
              code_verifier: got.verifier,
            }),
          });
          const body = (await r.json().catch(() => ({}))) as { access_token?: string };
          if (!r.ok || !body.access_token) {
            res.writeHead(502, { 'content-type': 'text/plain' });
            return res.end(`hub token exchange failed (${r.status})`);
          }
          hubSession.token = body.access_token;
          res.writeHead(302, { location: got.next });
          return res.end();
        }
        next();
      });
    },
  };
}

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
    // VITE_CACHE_DIR: a dev server's own optimized-deps cache, so another server's `--force` restart on this
    // shared checkout cannot delete the chunks this one is serving.
    ...(env.VITE_CACHE_DIR ? { cacheDir: env.VITE_CACHE_DIR } : {}),
    build: {
      sourcemap: true,
      outDir: 'dist',
    },
    plugins: [
      ...(env.HUB_LOGIN === '1' && env.PROXY_TARGET ? [hubLoginPlugin(env.PROXY_TARGET.replace(/\/$/, ''))] : []),
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
          // Vendor marks the landing pages bundle (they render on the hub, which serves no icon packs).
          path.resolve(__dirname, '../flow_sdk/server/icons/brands/assets'),
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
      //
      // The same holds for where that login lands: the hub answers
      // `/api/v1/login` with `<app_url>/login.html` (custom_jwt_provider), and
      // login.html / signup.html are the HUB's pages (its public dir), with
      // their hashed bundles under `/assets` and the SDK they load from `/sdk` --
      // this dev server has none of those and serves neither path itself. Unproxied, `/login.html` fell through to
      // the SPA and looped exactly as above; so they go to the hub too.
      proxy: (() => {
        // PROXY_TARGET: where /api goes when it is not __API_URL__ itself -- set VITE_API_URL to this dev server
        // and PROXY_TARGET to a desktop (e.g. the signed-in prod desktop on 9007) so the browser stays same-origin.
        const target = env.PROXY_TARGET || env.VITE_API_URL || `http://localhost:${env.LOCAL_SERVER_PORT || '9007'}`;
        // FLOWPAD_GATE_TOKEN: the target desktop's cookie-gate token, presented on every proxied call.
        const gate = env.FLOWPAD_GATE_TOKEN ? { 'X-Cookie-Gate': env.FLOWPAD_GATE_TOKEN } : undefined;
        // PROD_READ_ONLY=1: refuse every write, so a dev UI pointed at real data can only look.
        const readOnly = env.PROD_READ_ONLY === '1';
        // PROD_WRITE_ALLOW=<regex>: the writes a read-only proxy still lets through (one validation's actions only).
        const writeAllow = env.PROD_WRITE_ALLOW ? new RegExp(env.PROD_WRITE_ALLOW) : null;
        const guard = (o: Record<string, unknown>) => ({
          ...o,
          ...(gate ? { headers: gate } : {}),
          configure: (proxy: import('vite').HttpProxy.Server) => {
            const bearer = (p: import('http').ClientRequest) => {
              if (hubSession.token) p.setHeader('Authorization', `Bearer ${hubSession.token}`);
            };
            proxy.on('proxyReq', bearer);
            proxy.on('proxyReqWs', bearer);
          },
          ...(readOnly
            ? {
                bypass: (req: { method?: string }, res: import('http').ServerResponse | undefined) => {
                  if (['GET', 'HEAD', 'OPTIONS'].includes((req.method || 'GET').toUpperCase())) return undefined;
                  // Signing in and out is not a data write: let the auth steps through.
                  const url = (req as { url?: string }).url || '';
                  if (writeAllow?.test(url)) return undefined;
                  if (/^\/api\/v1\/(login|logout|auth|token|oauth)/.test(url)) {
                    return undefined;
                  }
                  res?.writeHead(403, { 'content-type': 'application/json' });
                  res?.end(JSON.stringify({ status: 'FAIL', message: 'read-only dev proxy (PROD_READ_ONLY=1)' }));
                  return false;
                },
              }
            : {}),
        });
        return Object.fromEntries(
          Object.entries({
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
            '/login.html': { target, changeOrigin: true },
            '/signup.html': { target, changeOrigin: true },
            '/assets': { target, changeOrigin: true },
            '/sdk': { target, changeOrigin: true },
          }).map(([k, v]) => [k, guard(v as Record<string, unknown>)]),
        );
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
