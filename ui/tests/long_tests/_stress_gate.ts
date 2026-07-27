import { describe } from 'vitest';

/**
 * Opt-in gate for the host-capacity-bound real-CLI STRESS / TIMING long tests.
 *
 * These spawn MANY real `claude` PTY subprocesses (20–80 per file) and/or assert
 * tight launch/turn latency budgets. They only pass on a host with spare capacity
 * and saturate a shared/loaded dev box — the documented "pass-on-a-quiet-host"
 * class (a launch that is ~1s in isolation blows a 4s budget once dozens of live
 * PTYs pile up). Their timeouts are non-negotiable, so on a busy machine they can
 * only fail for environmental reasons.
 *
 * Default OFF so a routine `npm run test:vitest:long` (e2e-qa Phase 7) runs only
 * the lighter long tests. Set `RUN_PTY_STRESS=1` to run them on dedicated CI with
 * spare capacity — mirroring how the pytest `stress_matrix` suite is default-off.
 *
 * Usage: replace the file's top-level `describe(...)` with `stressDescribe(...)`.
 */
export const stressEnabled = !!process.env.RUN_PTY_STRESS;
export const stressDescribe = stressEnabled ? describe : describe.skip;
