/**
 * The backend decides where a `flow show` goes (`tab.show_placement`, pinned by
 * tests/unit/test_show_placement.py); this pins what the listener does with it.
 */
import { describe, expect, it } from 'vitest';
import { showTabSlot } from '@src/hooks/use-show-target-listener';

const TAB = '00000000-0000-4000-8000-0000000000a1';
const file = { kind: 'vfs', path: '/ws/a.html' };
const screen = { kind: 'dock', view_type: 'credentials' };

describe('showTabSlot', () => {
  it('a host (Vibe) tab pins deliverables in its own Display pane — not this listener\'s', () => {
    expect(showTabSlot(file, { tab_id: TAB, host: true })).toBeNull();
  });

  it('a host tab nests a SCREEN as its child', () => {
    expect(showTabSlot(screen, { tab_id: TAB, host: true })).toEqual({ afterTabId: TAB, parentTabId: TAB });
  });

  it('a terminal tab gets every kind as a top-level tab beside it', () => {
    expect(showTabSlot(file, { tab_id: TAB, host: false })).toEqual({ afterTabId: TAB, parentTabId: null });
    expect(showTabSlot(screen, { tab_id: TAB, host: false })).toEqual({ afterTabId: TAB, parentTabId: null });
  });

  it('no open tab (a background agent): a plain tab at the end', () => {
    expect(showTabSlot(file, { tab_id: null, host: false })).toEqual({ afterTabId: null, parentTabId: null });
  });
});
