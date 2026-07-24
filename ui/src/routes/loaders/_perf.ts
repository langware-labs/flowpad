// Per-nav perf instrumentation for /dock/shell loaders.
// Each `navigateToSession` click stamps `__shellNavT0` on window; downstream
// loader steps log relative timings. Gated to dev builds.
//
// The same steps also emit under the `process_load` toplog tag (runtime
// toggleable, no T0 stamp needed) so a slow tab-switch can be traced in any
// session — `toplog.on('process_load')` — without pre-instrumenting the click.

import { toplog } from '@sdk';

export const PERF_T0_KEY = '__shellNavT0';

function readT0(): number | undefined {
  return (window as Record<string, unknown>)[PERF_T0_KEY] as number | undefined;
}

export function perfLog(label: string): void {
  if (toplog.isOn('process_load')) toplog.log('process_load', label);
  if (!import.meta.env.DEV) return;
  const t0 = readT0();
  if (t0 === undefined) return;
  console.log(`[PERF] +${(performance.now() - t0).toFixed(0)}ms ${label}`);
}

export async function perfTime<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const tagOn = toplog.isOn('process_load');
  if (!import.meta.env.DEV && !tagOn) return fn(); // zero-cost when nothing listens
  const t0 = readT0();
  const start = performance.now();
  try {
    return await fn();
  } finally {
    const dur = performance.now() - start;
    if (tagOn) toplog.log('process_load', `${label} took ${dur.toFixed(1)}ms`);
    if (import.meta.env.DEV && t0 !== undefined) {
      console.log(`[PERF] +${(performance.now() - t0).toFixed(0)}ms ${label} took ${dur.toFixed(1)}ms`);
    }
  }
}

export function markPerfT0(): void {
  if (!import.meta.env.DEV) return;
  (window as Record<string, unknown>)[PERF_T0_KEY] = performance.now();
}
