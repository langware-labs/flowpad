/** The dataset editor's review helpers: which rows need a label, "Correct" as a label, what a run did. */
import { describe, expect, it } from 'vitest';

import { didSummary, labelFromOutput, needsLabel } from '../../../ts_sdk/src/apps/dataset-editor';

describe('dataset editor review', () => {
  it('a row a run answered with no gold needs a label; a labelled or unrun one does not', () => {
    expect(needsLabel({ output: { route: 'agentic' } })).toBe(true);
    expect(needsLabel({ output: { route: 'agentic' }, ground_truth: { route: 'agentic' } })).toBe(false);
    expect(needsLabel({ ground_truth: null })).toBe(false);
  });

  it('"Correct" labels the output minus the producer-only confidence', () => {
    const output = { route: 'quick', target: { kind: 'view', value: 'data-sources' }, verb: 'show', confidence: 1 };
    expect(labelFromOutput(output)).toEqual({
      route: 'quick',
      target: { kind: 'view', value: 'data-sources' },
      verb: 'show',
    });
  });

  it('says what a logged run did', () => {
    expect(didSummary({ address: '/dock/data-sources' })).toBe('/dock/data-sources');
    expect(didSummary({ prompt: 'summarize the README' })).toBe('→ assistant');
    expect(didSummary(undefined)).toBe('');
  });
});
