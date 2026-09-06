import { describe, expect, it } from 'vitest';
import { ViewMode } from '@src/contexts/view-mode-context';
import {
  MODE_CHAIN,
  NO_GATES,
  RAIL_ITEMS,
  resolveRail,
  type RailGate,
  type RailItemId,
} from '@src/components/collapsed-sidebar/rail-visibility';

/**
 * The rail's two invariants, as tests.
 *
 * This file previously proved equivalence with a per-mode DELTA table that had a
 * removal escape hatch (`noShow`). That hatch had exactly one use — dropping
 * Bookmarks at Standard — and it produced the bug this slice fixes: stepping UP a
 * mode made an icon disappear. The model is now strictly additive, so the
 * equivalence tests are gone and the monotonicity test below is what stops it
 * coming back.
 */

const ALL_GATES: Record<RailGate, boolean> = { conversations: true };

const idsFor = (mode: ViewMode, gates = ALL_GATES): RailItemId[] =>
  resolveRail(mode, gates).map((item) => item.id);

/** Is `sub` a subsequence of `full` (same relative order, gaps allowed)? */
function isSubsequence<T>(sub: readonly T[], full: readonly T[]): boolean {
  let i = 0;
  for (const item of full) if (i < sub.length && sub[i] === item) i++;
  return i === sub.length;
}

describe('resolveRail — modes are strictly additive', () => {
  it('every fuller mode is a superset of the simpler one', () => {
    for (let i = 1; i < MODE_CHAIN.length; i++) {
      const simpler = new Set(idsFor(MODE_CHAIN[i - 1]));
      const fuller = new Set(idsFor(MODE_CHAIN[i]));
      const lost = [...simpler].filter((id) => !fuller.has(id));
      expect(lost, `${MODE_CHAIN[i]} dropped ${lost.join(', ')} from ${MODE_CHAIN[i - 1]}`).toEqual([]);
    }
  });

  it('Standard is Vibe plus nothing — the two rails have the same members', () => {
    // Standard's only difference from Vibe is what `chats` targets, which is a
    // click-time fork in the component, not a membership difference.
    expect(idsFor(ViewMode.Standard)).toEqual(idsFor(ViewMode.Vibe));
  });

  it('each mode adds the items declared at it', () => {
    // `events` merged the old `triggers` (Advanced) and `signals` (Dev) items.
    // It stays at Advanced, not Dev: dropping to Dev would have removed rules
    // from a mode that already had them, which is a subtraction the additive
    // chain above forbids.
    expect(idsFor(ViewMode.Advanced)).toContain('events');
    expect(idsFor(ViewMode.Advanced)).toContain('hooks');
    expect(idsFor(ViewMode.Standard)).not.toContain('events');
    // The merged ids are gone, not merely relocated.
    expect(idsFor(ViewMode.Dev)).not.toContain('triggers');
    expect(idsFor(ViewMode.Dev)).not.toContain('signals');
    expect(idsFor(ViewMode.Dev)).toEqual(expect.arrayContaining(['discover', 'graph-workflows', 'capabilities']));
    expect(idsFor(ViewMode.Advanced)).not.toContain('discover');
    // Data sources took the Tasks slot, but at Advanced rather than Vibe.
    expect(idsFor(ViewMode.Advanced)).toContain('data-sources');
    expect(idsFor(ViewMode.Standard)).not.toContain('data-sources');
  });

  it('connections sits directly under the inbox, in every mode', () => {
    // Vibe and ungated on purpose: this screen is where the first connection is
    // made, so it must not be hidden from the mode — or the state — that needs it
    // most. Adjacency is the requested placement, so it is pinned rather than
    // left to survive the next edit to RAIL_ITEMS by luck.
    for (const mode of MODE_CHAIN) {
      const ids = idsFor(mode);
      expect(ids).toContain('credentials');
      expect(ids[ids.indexOf('credentials') - 1]).toBe('inbox');
    }
  });

  it('keeps its slot when the inbox gate drops the item above it', () => {
    const ids = idsFor(ViewMode.Vibe, { conversations: false });
    expect(ids).not.toContain('inbox');
    expect(ids).toContain('credentials');
  });
});

describe('resolveRail — order is the same in every mode', () => {
  const specOrder = RAIL_ITEMS.map((item) => item.id);

  for (const mode of MODE_CHAIN) {
    it(`${mode}'s rail is a subsequence of RAIL_ITEMS`, () => {
      expect(isSubsequence(idsFor(mode), specOrder)).toBe(true);
    });
  }

  it('holds when gates drop items out of the middle', () => {
    const gated = idsFor(ViewMode.Dev, { conversations: false });
    expect(isSubsequence(gated, specOrder)).toBe(true);
    expect(gated).not.toContain('inbox');
    expect(gated).toContain('chats');
  });

  it('places the top rail in the agreed order', () => {
    const top = resolveRail(ViewMode.Vibe, ALL_GATES)
      .filter((item) => item.placement === 'top')
      .map((item) => item.id);
    expect(top).toEqual(['chats', 'inbox', 'credentials']);
  });
});

describe('resolveRail — content gates', () => {
  it('drops gated items when their gate is unsatisfied', () => {
    const none = idsFor(ViewMode.Dev, NO_GATES);
    expect(none).not.toContain('inbox');
    // Ungated neighbours survive — including data-sources, which must NOT be
    // gated on "a source exists": this screen is where the first one is made.
    expect(none).toEqual(expect.arrayContaining(['chats', 'data-sources']));
  });

  it('gates only the item they name', () => {
    const convsOnly = idsFor(ViewMode.Vibe, { conversations: true });
    expect(convsOnly).toContain('inbox');

    const neither = idsFor(ViewMode.Vibe, NO_GATES);
    expect(neither).not.toContain('inbox');
    expect(neither).toContain('chats');
  });

  it('a fresh instance shows exactly Chats and Connections', () => {
    // Home, the project, Files and Bookmarks all used to sit here; each moved to
    // the top navigation bar. Connections stays because it is ungated: a fresh
    // instance is precisely when you need to connect something.
    const top = resolveRail(ViewMode.Vibe, { conversations: false })
      .filter((item) => item.placement === 'top')
      .map((item) => item.id);
    expect(top).toEqual(['chats', 'credentials']);
  });

  it('leaves Home, project, Files and Bookmarks to the top navigation bar', () => {
    const ids = RAIL_ITEMS.map((item) => item.id as string);
    for (const moved of ['home', 'project', 'files', 'bookmarks']) {
      expect(ids, `${moved} should have moved to the top bar`).not.toContain(moved);
    }
  });
});

describe('RAIL_ITEMS — spec integrity', () => {
  it('has no Assets entry (the project item already opens them)', () => {
    expect(RAIL_ITEMS.find((item) => (item.id as string) === 'assets')).toBeUndefined();
  });

  it('has no Tasks entry — the project item owns the list/task surface', () => {
    // Data sources took this slot. Re-adding Tasks re-creates the "one click
    // lights two rail buttons" problem the onTasks/onAssets subtraction existed
    // to avoid, which is why that subtraction is now gone too.
    expect(RAIL_ITEMS.find((item) => (item.id as string) === 'tasks')).toBeUndefined();
  });

  it('declares each id exactly once', () => {
    const ids = RAIL_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('only declares modes that exist in the chain', () => {
    for (const item of RAIL_ITEMS) expect(MODE_CHAIN).toContain(item.from);
  });
});
