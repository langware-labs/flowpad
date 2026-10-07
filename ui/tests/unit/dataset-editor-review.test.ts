/** The dataset editor's review rule: which rows need a label. (How a row LOOKS is its kind's viewer's.) */
import { describe, expect, it } from 'vitest';

import { needsLabel } from '../../../ts_sdk/src/apps/dataset-editor';

describe('dataset editor review', () => {
  it('a row a run answered with no gold needs a label; a labelled or unrun one does not', () => {
    expect(needsLabel({ output: { route: 'agentic' } })).toBe(true);
    expect(needsLabel({ output: { route: 'agentic' }, ground_truth: { route: 'agentic' } })).toBe(false);
    expect(needsLabel({ ground_truth: null })).toBe(false);
  });
});
