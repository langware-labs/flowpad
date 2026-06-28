import { describe, expect, it } from 'vitest';
import {
  MAX_IMPROVE_CYCLES,
  projectedRunSavingsUsd,
  shouldRunAnotherCycle,
} from '@src/components/terminal/interactive-terminal/side-windows/analysis-improvements';
import type { AgentTraceDoc } from '@src/components/assets/editor/agent-trace/trace-types';

/** Trace doc carrying one improvable skill (the only field the loop reads). */
const withFinding = (): AgentTraceDoc =>
  ({ annotations: { by_skill: { 'product-finder': { skill: 'product-finder', findings: [{ kind: 'issue', label: 'x' }] } } } } as unknown as AgentTraceDoc);
const noFindings = (): AgentTraceDoc =>
  ({ annotations: { by_skill: {} } } as unknown as AgentTraceDoc);

describe('shouldRunAnotherCycle — the full-analysis loop stop condition', () => {
  it('continues while there are improvable skills, under the cap, with a clean tree', () => {
    expect(shouldRunAnotherCycle({ cycleCount: 0, priorCycleDirty: false, analysisDoc: withFinding() })).toBe(true);
    expect(shouldRunAnotherCycle({ cycleCount: 2, priorCycleDirty: false, analysisDoc: withFinding() })).toBe(true);
  });

  it('stops at the 3-cycle cap even if findings remain', () => {
    expect(shouldRunAnotherCycle({ cycleCount: MAX_IMPROVE_CYCLES, priorCycleDirty: false, analysisDoc: withFinding() })).toBe(false);
  });

  it('stops when the latest analysis found nothing improvable (converged)', () => {
    expect(shouldRunAnotherCycle({ cycleCount: 1, priorCycleDirty: false, analysisDoc: noFindings() })).toBe(false);
    expect(shouldRunAnotherCycle({ cycleCount: 0, priorCycleDirty: false, analysisDoc: null })).toBe(false);
  });

  it('stops when the prior cycle left an unsaved improvement (commit/review first)', () => {
    expect(shouldRunAnotherCycle({ cycleCount: 0, priorCycleDirty: true, analysisDoc: withFinding() })).toBe(false);
  });

  it('drives a converging sequence: improve twice, then a clean analysis ends it', () => {
    // Each cycle: analyze (improvable) → improve+save (clean) → re-analyze.
    const cycle = (n: number, doc: AgentTraceDoc) =>
      shouldRunAnotherCycle({ cycleCount: n, priorCycleDirty: false, analysisDoc: doc });
    let cycles = 0;
    const analyses = [withFinding(), withFinding(), noFindings()]; // converges on the 3rd analysis
    while (cycle(cycles, analyses[cycles])) cycles++;
    expect(cycles).toBe(2); // ran 2 improve cycles, stopped when the 3rd analysis was clean
  });

  it('never exceeds the cap even if findings never clear', () => {
    let cycles = 0;
    while (shouldRunAnotherCycle({ cycleCount: cycles, priorCycleDirty: false, analysisDoc: withFinding() })) cycles++;
    expect(cycles).toBe(MAX_IMPROVE_CYCLES);
  });
});

describe('value projection — the modal "$X/run reclaimable" headline', () => {
  it('projectedRunSavingsUsd sums the attention-severity segment cost', () => {
    const doc = {
      summary: { issue_count: 1, divergence_count: 0, cost_usd: 1.0 },
      lanes: [{ segments: [
        { cost_usd: 0.30, severity: 'attention' },
        { cost_usd: 0.50, severity: 'info' },
        { cost_usd: 0.10, severity: 'attention' },
      ] }],
    } as unknown as AgentTraceDoc;
    expect(projectedRunSavingsUsd(doc)).toBeCloseTo(0.40, 5); // 0.30 + 0.10
  });

  it('falls back to a conservative fraction only when there are findings + no segment costs', () => {
    const noSeg = { summary: { issue_count: 2, divergence_count: 0, cost_usd: 1.0 }, lanes: [] } as unknown as AgentTraceDoc;
    expect(projectedRunSavingsUsd(noSeg)).toBeCloseTo(0.15, 5); // 1.0 × 0.15
    const clean = { summary: { issue_count: 0, divergence_count: 0, cost_usd: 1.0 }, lanes: [] } as unknown as AgentTraceDoc;
    expect(projectedRunSavingsUsd(clean)).toBe(0); // no findings → no claim
    expect(projectedRunSavingsUsd(null)).toBe(0);
  });
});
