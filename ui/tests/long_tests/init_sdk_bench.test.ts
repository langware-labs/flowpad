/**
 * init-sdk benchmark — time the REAL production `initSdk()` on a FRESH backend
 * instance, 10 times, with a fresh disposable instance per timing and a kill in
 * between.
 *
 * Unlike the lean hub-harness (`getInstance`, which times only
 * bootstrap+loadTypes+connect), this calls `@sdk/main`'s `initSdk()` — the exact
 * function the app shell runs at startup: bootstrap → loadTypes → seed cloud →
 * set domain/visitor/compute_node/project/agent/user context → connect WS →
 * authManager.init → dataContext.initContext.
 *
 * Isolation, two layers (see `prepareCleanRealm`):
 *  • SDK module singletons (sdkConfig/dataManager/apiClient/connectionManager/
 *    dataContext/initPromise/…) ARE fresh per instance — `vi.resetModules()` +
 *    re-`import('@sdk')` rebuilds the graph, and `load_config()` binds it to this
 *    backend via `globalThis.__FLOWPAD_API_URL__`.
 *  • The jsdom `window`/`globalThis`/`localStorage` is ONE object shared by all
 *    iterations (single worker). `initSdk` reads `localStorage`/`window.location`
 *    and writes `window.appReady`/`window.context`, so we explicitly clear that
 *    shared state each run to give every instance a genuinely clean window.
 *
 * `initSdk` SWALLOWS errors (catch → navigator.error → return; sets
 * `window.appReady = true` only on success), so success is asserted via
 * `window.appReady`, not "didn't throw".
 *
 * Each iteration is its own `it()` (so each gets the long-project testTimeout —
 * no timeout is raised). A summary table is printed in `afterAll`.
 *
 * Run: cd ui && npx vitest run --bail 0 --project long init_sdk_bench
 */
import { afterAll, describe, expect, it } from 'vitest';
import { launchInstance, killInstance, prepareCleanRealm } from './_backend_lifecycle';

const RUNS = 10;
const results: Array<{ run: number; name: string; ok: boolean; launchMs?: number; initMs?: number; note?: string }> = [];

describe('init-sdk benchmark (fresh instance per timing)', () => {
  for (let i = 1; i <= RUNS; i++) {
    const name = `ref-${i}`;
    it(`run ${i}/${RUNS}: launch ${name} → initSdk() → kill`, async () => {
      const tLaunch = performance.now();
      const port = await launchInstance(name);
      const launchMs = performance.now() - tLaunch;

      if (!port) {
        results.push({ run: i, name, ok: false, launchMs, note: 'launch/health failed' });
        await killInstance(name);
        expect.soft(port, `${name} failed to launch/become healthy`).not.toBeNull();
        return;
      }

      try {
        const { sdk, main } = await prepareCleanRealm(port);

        const tInit = performance.now();
        await main.initSdk(); // the real app-startup init (errors are swallowed inside)
        const initMs = performance.now() - tInit;

        // initSdk never throws — confirm it actually completed.
        const ready = (window as Record<string, unknown>).appReady === true;
        const gotBootstrap = !!sdk.dataContext.bootstrapInfo;
        if (ready && gotBootstrap) {
          results.push({ run: i, name, ok: true, launchMs, initMs });
        } else {
          results.push({ run: i, name, ok: false, launchMs, note: `initSdk incomplete (appReady=${ready}, bootstrap=${gotBootstrap})` });
        }
        expect.soft(ready && gotBootstrap, 'initSdk should complete (appReady + bootstrapInfo)').toBe(true);
      } catch (err) {
        results.push({ run: i, name, ok: false, launchMs, note: `init sdk threw: ${(err as Error).message}` });
        expect.soft(err, 'init sdk should not throw').toBeUndefined();
      } finally {
        await killInstance(name);
      }
    });
  }

  afterAll(() => {
    const ok = results.filter((r) => r.ok);
    const inits = ok.map((r) => r.initMs!).sort((a, b) => a - b);
    const sum = inits.reduce((a, b) => a + b, 0);
    const mean = inits.length ? sum / inits.length : 0;
    const median = inits.length ? inits[Math.floor((inits.length - 1) / 2)] : 0;

    const lines = ['', '=== init-sdk benchmark — status ===', `runs: ${results.length}  ok: ${ok.length}  failed: ${results.length - ok.length}`, ''];
    for (const r of results) {
      lines.push(
        r.ok
          ? `  run ${String(r.run).padStart(2)} ${r.name.padEnd(7)} OK   launch=${(r.launchMs! / 1000).toFixed(1)}s  init-sdk=${r.initMs!.toFixed(0)}ms`
          : `  run ${String(r.run).padStart(2)} ${r.name.padEnd(7)} FAIL ${r.note ?? ''}`,
      );
    }
    if (inits.length) {
      lines.push('', `  init-sdk  min=${inits[0].toFixed(0)}ms  median=${median.toFixed(0)}ms  mean=${mean.toFixed(0)}ms  max=${inits[inits.length - 1].toFixed(0)}ms`);
    }
    lines.push('===================================', '');
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
  });
});
