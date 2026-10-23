/** Close-in-place state machine (close-freeze.ts). Pure, no DOM. */
import { describe, expect, it } from 'vitest';
import {
  chipSizing,
  FREEZE_IDLE,
  freezeReducer,
  type FreezeEvent,
  type FreezeState,
} from '@src/components/tabs/close-freeze';

/** A close of tab 1 of 5 (middle), tab 4 of 5 (last), or tab 0 of 1 (the only one). */
const close = (tabPx: number, where: 'middle' | 'last' | 'only' = 'middle'): FreezeEvent => ({
  type: 'closeByMouse',
  tabPx,
  maxPx: 200,
  ...(where === 'middle' ? { index: 1, count: 5 } : where === 'last' ? { index: 4, count: 5 } : { index: 0, count: 1 }),
});
const RELEASE: FreezeEvent = { type: 'release' };
const run = (events: FreezeEvent[], from: FreezeState = FREEZE_IDLE) => events.reduce(freezeReducer, from);
const limits = { maxPx: 200, minPx: 40 };

describe('freezeReducer', () => {
  it('a middle close freezes at the clicked width with no spacer', () => {
    expect(run([close(120)])).toEqual({ frozenPx: 120, leadPad: 0 });
  });

  it('each close from the end grows the spacer by one stride', () => {
    expect(run([close(120, 'last')]).leadPad).toBe(121);
    expect(run([close(120, 'last'), close(120, 'last')]).leadPad).toBe(242);
    expect(run([close(120, 'last'), close(120, 'last'), close(120, 'last')]).leadPad).toBe(363);
  });

  it('closing the last tab at full width adds no spacer (the row has free space)', () => {
    expect(run([close(200, 'last')])).toEqual({ frozenPx: 200, leadPad: 0 });
  });

  it('closing the only/first tab adds no separator width', () => {
    expect(run([close(120, 'only')]).leadPad).toBe(120);
  });

  it('mixed middle and end closes only grow the spacer on end closes', () => {
    expect(run([close(120), close(120, 'last'), close(120), close(120, 'last')])).toEqual({
      frozenPx: 120,
      leadPad: 242,
    });
  });

  it('keeps the first width while frozen, so the stride never drifts', () => {
    // Later measurements can differ by sub-pixels; the first one wins.
    expect(run([close(120, 'last'), close(119.6, 'last'), close(121.2)])).toEqual({ frozenPx: 120, leadPad: 242 });
  });

  it('release returns to normal from a frozen state', () => {
    expect(freezeReducer(run([close(120, 'last'), close(120)]), RELEASE)).toEqual(FREEZE_IDLE);
  });

  it('release when not frozen returns the same object (no re-render)', () => {
    expect(freezeReducer(FREEZE_IDLE, RELEASE)).toBe(FREEZE_IDLE);
  });

  it('freezes again after a release, at the new width', () => {
    const s = run([close(120, 'last'), RELEASE, close(90)]);
    expect(s).toEqual({ frozenPx: 90, leadPad: 0 });
  });
});

describe('chipSizing', () => {
  it('normal: equal flex share with min/max', () => {
    expect(chipSizing(null, false, limits)).toEqual({ flex: '1 1 200px', minWidth: 40, maxWidth: 200 });
  });
  it('frozen: one fixed width', () => {
    expect(chipSizing(120, false, limits)).toEqual({ flex: '0 0 120px', minWidth: 120, maxWidth: 120 });
  });
  it('renaming wins over frozen and normal', () => {
    expect(chipSizing(120, true, limits)).toEqual({ width: 200, flex: 'none' });
    expect(chipSizing(null, true, limits)).toEqual({ width: 200, flex: 'none' });
  });
});
