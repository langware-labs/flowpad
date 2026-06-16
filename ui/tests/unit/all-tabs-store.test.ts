/**
 * all-tabs-store drag data-path: the optimistic predicted order must mirror the
 * backend algebra exactly (so the dropped chip paints in its final place), and an
 * adopted list replaces the prediction. A no-op drop leaves the order untouched.
 * The pointer-level drag UI is verified live (jsdom has no real layout for
 * hit-testing); this locks the data flow the drag drives.
 */
import { describe, expect, it } from 'vitest';
import type { TabRow } from '@sdk';
import { applyAllTabRows, applyPredictedOrder, getAllTabRowsSnapshot } from '@src/tabs/all-tabs-store';

const applyRows = (rows: TabRow[], _project?: string) => applyAllTabRows(rows);
const getTabRowsSnapshot = getAllTabRowsSnapshot;

function row(id: string): TabRow {
  return {
    id,
    pointer: id,
    target_type: null,
    target_id: null,
    project_id: 'p1',
    name: id,
    icon_key: null,
    worktree: false,
    tab_order: 0,
    last_active_at: null,
    status: null,
    is_disabled: false,
  };
}

const ids = () => getTabRowsSnapshot().map((r) => r.id);

describe('tab-store predicted order (drag data path)', () => {
  it('adopts a backend-returned list verbatim', () => {
    applyRows([row('a'), row('b'), row('c')], 'p1');
    expect(ids()).toEqual(['a', 'b', 'c']);
  });

  it('predicts move-right exactly like computeReorder (drop a after b)', () => {
    applyRows([row('a'), row('b'), row('c')], 'p1');
    applyPredictedOrder('a', 'b', 'c');
    expect(ids()).toEqual(['b', 'a', 'c']);
  });

  it('predicts drop-to-start (after = null)', () => {
    applyRows([row('a'), row('b'), row('c')], 'p1');
    applyPredictedOrder('c', null, 'a');
    expect(ids()).toEqual(['c', 'a', 'b']);
  });

  it('no-op drop leaves order unchanged', () => {
    applyRows([row('a'), row('b'), row('c')], 'p1');
    applyPredictedOrder('b', 'a', 'c');
    expect(ids()).toEqual(['a', 'b', 'c']);
  });

  it('the backend list replaces an optimistic prediction', () => {
    applyRows([row('a'), row('b'), row('c')], 'p1');
    applyPredictedOrder('a', 'c', null); // optimistic: a to end
    expect(ids()).toEqual(['b', 'c', 'a']);
    applyRows([row('a'), row('b'), row('c')], 'p1'); // server says: unchanged
    expect(ids()).toEqual(['a', 'b', 'c']);
  });
});
