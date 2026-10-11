/**
 * The TS mirror of `returned_value_spec.py` knows the decision verdict: its kind, its guard,
 * and the wizard result's `stopped_at`. Pinned beside the Python by the parity test.
 */
import { describe, expect, it } from 'vitest';

import { ANSWER_KIND, isCliResult, isDecisionVerdict, isWizardResult, type DecisionVerdict, type WizardResult } from '@sdk/models/ReturnedValue';

describe('DecisionVerdict mirror', () => {
  it('names the kind the Python answer carries', () => {
    expect(ANSWER_KIND.decision).toBe('compute.returned.decision');
  });

  it('is told apart from the other answers by its kind alone', () => {
    const verdict: DecisionVerdict = {
      spec_kind: ANSWER_KIND.decision,
      exit_code: 0,
      met: true,
      confidence: 0.93,
      reason: 'asks for a refund',
      answers: { match: { type: 'yes_no', probability: 0.93 } },
    } as DecisionVerdict;
    expect(isDecisionVerdict(verdict)).toBe(true);
    expect(isCliResult(verdict)).toBe(false);
    expect(isWizardResult(verdict)).toBe(false);
    expect(isDecisionVerdict({ spec_kind: ANSWER_KIND.cli })).toBe(false);
    expect(isDecisionVerdict(null)).toBe(false);
  });

  it('reads a verdict nested in a wizard result, and the step that stopped it', () => {
    const run: WizardResult = {
      spec_kind: ANSWER_KIND.wizard,
      exit_code: 0,
      stopped_at: 'route',
      steps: { route: { spec_kind: ANSWER_KIND.decision, exit_code: 1, met: false, reason: 'team was bug' } },
    } as WizardResult;
    const step = run.steps?.route;
    expect(isDecisionVerdict(step)).toBe(true);
    expect(run.stopped_at).toBe('route');
    expect(step?.met).toBe(false);
  });
});
