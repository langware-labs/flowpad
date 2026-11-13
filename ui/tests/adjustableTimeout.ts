/**
 * ADJUSTABLE_TIMEOUT: seconds a RUNNER adds to every fixed test timeout (default 0 = the committed values).
 * Set it in the environment of a slower host (e.g. ADJUSTABLE_TIMEOUT=10); never edit a cap in a config for that.
 * Mirror of tests/adjustable_timeout.py on the Python side.
 */
const seconds = Number(process.env.ADJUSTABLE_TIMEOUT ?? 0);
export const ADJUSTABLE_TIMEOUT_MS = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;

/**
 * With ADJUSTABLE_TIMEOUT on, a running Playwright test's cap grows by the slack each `adjusted()` wait inside it
 * adds: the config or `test.setTimeout` adds it to the cap once, while a test can hold several waits. Only in a
 * Playwright worker (TEST_WORKER_INDEX); vitest fixes a test's timer when the test is defined, so it cannot grow.
 */
type RunningTest = { timeout: number; setTimeout(ms: number): void };
let runningTest: (() => RunningTest) | undefined;
if (ADJUSTABLE_TIMEOUT_MS && process.env.TEST_WORKER_INDEX !== undefined) {
  void import('@playwright/test')
    .then(({ test }) => {
      runningTest = () => test.info();
    })
    .catch(() => {});
}

function growRunningTest(): void {
  if (!runningTest) return;
  let info: RunningTest;
  try {
    info = runningTest();
  } catch {
    return; // not inside a test: the config, a module constant
  }
  if (info.timeout > 0) info.setTimeout(info.timeout + ADJUSTABLE_TIMEOUT_MS);
}

/** `ms` plus this runner's ADJUSTABLE_TIMEOUT. 0 (no limit) stays 0. Inside a running test, its cap grows too. */
export const adjusted = (ms: number): number => {
  if (!ms) return ms;
  if (ADJUSTABLE_TIMEOUT_MS) growRunningTest();
  return ms + ADJUSTABLE_TIMEOUT_MS;
};

/**
 * ADJUSTABLE_PERF_FACTOR: what a RUNNER multiplies every speed BUDGET by (default 1 = the committed values).
 * A perf budget scales with the host, so this is a factor, not seconds: adding seconds to a 150 ms budget would
 * make it meaningless. Set it in the environment of a slower host (e.g. ADJUSTABLE_PERF_FACTOR=2); never edit a
 * budget in a spec for that. Mirror of `adjusted_budget` in tests/adjustable_timeout.py.
 */
const factor = Number(process.env.ADJUSTABLE_PERF_FACTOR ?? 1);
export const ADJUSTABLE_PERF_FACTOR = Number.isFinite(factor) && factor > 0 ? factor : 1;

/** A speed budget `ms` times this runner's ADJUSTABLE_PERF_FACTOR. */
export const adjustedBudget = (ms: number): number => Math.round(ms * ADJUSTABLE_PERF_FACTOR);
