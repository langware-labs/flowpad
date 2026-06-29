/**
 * RCA capture: slowness notes fire many times for the SAME dock pointer type.
 *
 * Reported symptom: `loadAgentApp(agentic_process-052dd9a9-…)` logged a
 * "slowness detected" note 4× back-to-back. The expectation is one note per
 * dock-pointer type per session.
 *
 * Proven root cause (this session): `TimeIt.done()` calls `console.warn`
 * unconditionally — there is no per-name / per-session dedup. Every repeated
 * slow loader run (the shell route revalidates on each in-shell nav) emits a
 * fresh note. This test pins the expected once-per-name behaviour at the
 * narrowest layer (TimeIt itself). It FAILS today because each `.done()`
 * crossing the threshold logs again.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimeIt } from '../../src/utils/timeit';

describe('TimeIt slowness-note dedup', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs a slowness note only once per name per session', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Simulate the same dock pointer's loader running slow 4 times — exactly
    // the repeated revalidation seen in the report. threshold 0 => any elapsed
    // (>= 0) is "slow", so no sleeping is needed to cross it.
    for (let i = 0; i < 4; i++) {
      const t = new TimeIt('loadAgentApp(agentic_process-052dd9a9)');
      t.time('loadShellRoute');
      t.done(0);
    }

    expect(warn).toHaveBeenCalledTimes(1);
  });
});
