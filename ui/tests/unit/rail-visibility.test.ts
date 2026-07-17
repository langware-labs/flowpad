import { describe, expect, it } from 'vitest';
import { ViewMode } from '@src/contexts/view-mode-context';
import {
  MODE_CHAIN,
  RAIL_DELTAS,
  resolveRail,
  type RailDelta,
  type RailItemId,
  type RailStatus,
} from '@src/components/collapsed-sidebar/rail-visibility';

/**
 * Equivalence proof: the delta model must reproduce the rail exactly as the old
 * per-item visibility matrix rendered it (including the formerly special-cased
 * Bookmarks = vibe-only and Discover = dev-only affordances).
 */
const OLD_MATRIX: Record<ViewMode, Record<'visible' | 'collapsed', readonly RailItemId[]>> = {
  [ViewMode.Vibe]: {
    visible: ['home', 'inbox', 'bookmarks'],
    collapsed: ['files'],
  },
  [ViewMode.Standard]: {
    visible: ['home', 'chats', 'inbox'],
    collapsed: ['files'],
  },
  [ViewMode.Advanced]: {
    visible: ['home', 'chats', 'inbox', 'assets'],
    collapsed: ['triggers', 'hooks', 'files'],
  },
  [ViewMode.Dev]: {
    // 'agentic-flows' (FlowStudio) is an additive Dev-only rail item from the
    // flow-graph slice (d6f25601); its RAIL_DELTAS entry landed without this
    // reference being updated. No existing item's placement changed.
    visible: ['home', 'chats', 'inbox', 'assets', 'discover', 'agentic-flows'],
    collapsed: ['triggers', 'hooks', 'files', 'capabilities'],
  },
};

describe('resolveRail — equivalence with the legacy visibility matrix', () => {
  for (const mode of MODE_CHAIN) {
    it(`reproduces the ${mode} rail`, () => {
      const rail = resolveRail(mode);
      const byStatus = (s: RailStatus) =>
        [...rail.entries()].filter(([, v]) => v === s).map(([id]) => id);
      expect(new Set(byStatus('visible'))).toEqual(new Set(OLD_MATRIX[mode].visible));
      expect(new Set(byStatus('collapsed'))).toEqual(new Set(OLD_MATRIX[mode].collapsed));
    });
  }

  it('noShow removes an inherited icon from every higher mode (bookmarks)', () => {
    expect(resolveRail(ViewMode.Vibe).get('bookmarks')).toBe('visible');
    expect(resolveRail(ViewMode.Standard).has('bookmarks')).toBe(false);
    expect(resolveRail(ViewMode.Advanced).has('bookmarks')).toBe(false);
    expect(resolveRail(ViewMode.Dev).has('bookmarks')).toBe(false);
  });

  it('noShow defaults to empty for every mode that omits it', () => {
    for (const mode of MODE_CHAIN) {
      expect(RAIL_DELTAS[mode].noShow ?? []).toEqual(mode === ViewMode.Standard ? ['bookmarks'] : []);
    }
  });
});

describe('resolveRail — delta semantics (synthetic table)', () => {
  const SYNTH: Record<ViewMode, RailDelta> = {
    [ViewMode.Vibe]: { collapsed: ['files'] },
    [ViewMode.Standard]: { visible: ['files'] }, // promotion: collapsed → visible
    [ViewMode.Advanced]: { collapsed: ['files'] }, // demotion back
    [ViewMode.Dev]: { noShow: ['files'] }, // removal
  };

  it('a later entry for an id overrides the inherited status', () => {
    expect(resolveRail(ViewMode.Vibe, SYNTH).get('files')).toBe('collapsed');
    expect(resolveRail(ViewMode.Standard, SYNTH).get('files')).toBe('visible');
    expect(resolveRail(ViewMode.Advanced, SYNTH).get('files')).toBe('collapsed');
    expect(resolveRail(ViewMode.Dev, SYNTH).has('files')).toBe(false);
  });
});
