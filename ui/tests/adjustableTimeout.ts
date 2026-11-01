/**
 * ADJUSTABLE_TIMEOUT: seconds a RUNNER adds to every fixed test timeout (default 0 = the committed values).
 * Set it in the environment of a slower host (e.g. ADJUSTABLE_TIMEOUT=10); never edit a cap in a config for that.
 * Mirror of tests/adjustable_timeout.py on the Python side.
 */
const seconds = Number(process.env.ADJUSTABLE_TIMEOUT ?? 0);
export const ADJUSTABLE_TIMEOUT_MS = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;

/** `ms` plus this runner's ADJUSTABLE_TIMEOUT. 0 (no limit) stays 0. */
export const adjusted = (ms: number): number => (ms ? ms + ADJUSTABLE_TIMEOUT_MS : ms);
