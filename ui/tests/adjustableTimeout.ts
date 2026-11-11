/**
 * ADJUSTABLE_TIMEOUT: seconds a RUNNER adds to every fixed test timeout (default 0 = the committed values).
 * Set it in the environment of a slower host (e.g. ADJUSTABLE_TIMEOUT=10); never edit a cap in a config for that.
 * Mirror of tests/adjustable_timeout.py on the Python side.
 */
const seconds = Number(process.env.ADJUSTABLE_TIMEOUT ?? 0);
export const ADJUSTABLE_TIMEOUT_MS = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;

/** `ms` plus this runner's ADJUSTABLE_TIMEOUT. 0 (no limit) stays 0. */
export const adjusted = (ms: number): number => (ms ? ms + ADJUSTABLE_TIMEOUT_MS : ms);

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
