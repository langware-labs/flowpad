// Per-nav perf instrumentation for /dock/shell loaders.
// Each `navigateToSession` click stamps `__shellNavT0` on window; downstream
// loader steps log relative timings. Gated to dev builds.

export const PERF_T0_KEY = '__shellNavT0';

function readT0(): number | undefined {
  return (window as Record<string, unknown>)[PERF_T0_KEY] as number | undefined;
}

export function perfLog(label: string): void {
  if (!import.meta.env.DEV) return;
  const t0 = readT0();
  if (t0 === undefined) return;
  console.log(`[PERF] +${(performance.now() - t0).toFixed(0)}ms ${label}`);
}

export async function perfTime<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (!import.meta.env.DEV) return fn();
  const t0 = readT0();
  const start = performance.now();
  try {
    return await fn();
  } finally {
    if (t0 !== undefined) {
      const dur = performance.now() - start;
      console.log(`[PERF] +${(performance.now() - t0).toFixed(0)}ms ${label} took ${dur.toFixed(1)}ms`);
    }
  }
}

export function markPerfT0(): void {
  if (!import.meta.env.DEV) return;
  (window as Record<string, unknown>)[PERF_T0_KEY] = performance.now();
}
