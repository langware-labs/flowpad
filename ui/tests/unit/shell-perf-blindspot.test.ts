/**
 * RCA: why the reported `loadShellRoute` slowness is an OPAQUE single bar.
 *
 * The loader is wrapped in per-step `perfTime`/`perfLog` instrumentation that
 * WOULD attribute the 2-4s across its hops (waitForConnected → open → attach).
 * But every one of those helpers early-returns unless `window.__shellNavT0` is
 * set — and that marker is stamped ONLY by the two CLICK handlers
 * (useTerminalStripController.navigateToSession, collapsed-sidebar). A
 * revalidation-triggered loader run (the case in the report: same process,
 * 4× back-to-back, fired by a search/path change, NOT a strip click) never
 * stamps it, so the breakdown is suppressed and you see only TimeIt's opaque
 * `loadShellRoute` total.
 *
 * This pins the on/off switch: `window.__shellNavT0`.
 *   - unset (revalidation)  → 0 breakdown lines  (you can't see where time went)
 *   - set   (click-nav)     → 1 breakdown line   (instrumentation works)
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PERF_T0_KEY, perfTime } from '../../src/routes/loaders/_perf';

describe('loadShellRoute perf instrumentation blind spot', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as Record<string, unknown>)[PERF_T0_KEY];
  });

  it('emits a per-step [PERF] breakdown only when __shellNavT0 is stamped', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    // OFF — revalidation path: no click stamped the marker.
    delete (window as Record<string, unknown>)[PERF_T0_KEY];
    await perfTime('loadProcess', async () => 'x');
    const onRevalidation = log.mock.calls.length;

    // ON — click-nav path: marker stamped.
    (window as Record<string, unknown>)[PERF_T0_KEY] = performance.now();
    await perfTime('loadProcess', async () => 'x');
    const onClickNav = log.mock.calls.length - onRevalidation;

    expect(onRevalidation).toBe(0); // blind spot: slow revalidation runs print nothing
    expect(onClickNav).toBe(1); // breakdown only appears on click-originated nav
  });
});
