import path from 'path';
import { defineConfig, mergeConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import viteConfig from '../../vite.config';

// FLOW_INSTANCE selects the matching Vite mode, so the compile-time SDK URL and
// jsdom origin agree with the same `.env.<name>.local` that `_backend.ts`
// validates. The root Vitest config evaluates every project config even when a
// different project runs, so missing selection is hard-failed later by the
// headless setup hook rather than thrown during config evaluation.
const instanceName = process.env.FLOW_INSTANCE || '';
const mode = instanceName || 'test';
const env = loadEnv(mode, path.resolve(__dirname, '../../..'), '');
const instanceEnvMatches = !!instanceName && env.FLOW_INSTANCE === instanceName;
const port = instanceEnvMatches ? env.LOCAL_SERVER_PORT : '';
const apiUrl = instanceEnvMatches ? env.VITE_API_URL || (port ? `http://localhost:${port}` : '') : '';
const resolvedViteConfig =
  typeof viteConfig === 'function' ? viteConfig({ mode, command: 'serve' } as any) : viteConfig;

export default mergeConfig(
  resolvedViteConfig,
  defineConfig({
    resolve: {
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
      name: 'headless',
      environment: 'jsdom',
      environmentOptions: {
        // The SDK reads window.location for its WS origin; pin it at the selected
        // backend. Missing selection stays origin-only until the setup hook reds.
        jsdom: { url: port ? `http://localhost:${port}` : 'http://localhost' },
      },
      // reactSetup gives the jsdom DOM shims (matchMedia / ResizeObserver / …);
      // _setup adds the few extra browser primitives a FULL app boot touches
      // (WebSocket binding, IntersectionObserver, canvas) and resets the realm.
      // `_lingui-mock` MUST be first: it activates the source locale (imports
      // `@src/i18n-init`) so module-level `t`…`` macro calls (e.g. the
      // STATUS_CONFIG const in ClaudeTasksViewer) don't throw `I18n.t` at import
      // time when the full app's module graph is evaluated — matching the react
      // tier's setup order.
      setupFiles: [
        path.resolve(__dirname, '../_lingui-mock.ts'),
        path.resolve(__dirname, '../react/reactSetup.ts'),
        path.resolve(__dirname, './_setup.ts'),
      ],
      exclude: ['**/node_modules/**'],
      globals: true,
      css: false,
      // Full-app boot drives a real bootstrap round-trip against a live backend.
      // 30s matches the hub project's budget for real network legs.
      testTimeout: 30000, // do not increase timeout without approval
      hookTimeout: 30000, // do not increase timeout without approval
      // Process isolation per FILE (forks, not threads). Each full-app boot
      // leaves a live SDK realm behind it — an open WebSocket + initSdk timers
      // that a reused worker can't reap and that starve the next file's boot
      // (its realm-boot balloons from <1s to ~9s and the editor never opens in
      // budget). `isolate` recycles the fork between files — a FRESH child per
      // file kills those OS handles. Sequential (no fileParallelism) so
      // concurrent boots don't contend on the one backend.
      //
      // Cap the pool at ONE fork: with fileParallelism off we never run two
      // files at once, but tinypool otherwise pre-warms `minForks` = CPU-count
      // idle children, each piping stdio into the parent's shared stdout/stderr
      // socket — which trips Node's MaxListenersExceededWarning (vitest caps it
      // at 24). min=max=1 keeps isolation (isolate still respawns per file) with
      // a single live child, so listeners stay well under the limit.
      pool: 'forks',
      isolate: true,
      fileParallelism: false,
      poolOptions: {
        forks: { singleFork: false, minForks: 1, maxForks: 1 },
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
