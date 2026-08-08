// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { waitConditionHolds, waitPlan, type JourneyWaitCondition } from '@sdk';

/** The point of the extraction: a condition can be planned and evaluated with
 *  no component, no mocks, and no browser. */
describe('journey wait runtime', () => {
  it('plans what each condition needs watched', () => {
    const plan = waitPlan({ all: [{ click: 'ViewModeVibe' }, { element: { present: 'VibeDisplay' } }] });

    expect(plan.watchesDom).toBe(true);
    expect(plan.subs).toEqual([{ tag: 'app.ui.*.clicked', target: 'ViewModeVibe', occurrence: true }]);
  });

  it('reads an element condition off a real document', () => {
    document.body.innerHTML = '<div data-tag="VibeDisplay"></div>';
    const present: JourneyWaitCondition = { element: { present: 'VibeDisplay' } };
    const gone: JourneyWaitCondition = { element: { gone: 'VibeDisplay' } };

    expect(waitConditionHolds(present, null, false, new Set())).toBe(true);
    expect(waitConditionHolds(gone, null, false, new Set())).toBe(false);

    document.body.innerHTML = '';
    expect(waitConditionHolds(present, null, false, new Set())).toBe(false);
    expect(waitConditionHolds(gone, null, false, new Set())).toBe(true);
  });

  it('never satisfies `manual` on its own — only the tray advances it', () => {
    expect(waitConditionHolds({ manual: true }, null, true, new Set())).toBe(false);
  });
});
