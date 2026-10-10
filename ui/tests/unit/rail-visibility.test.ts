import { describe, expect, it } from 'vitest';
import { ViewMode } from '@src/contexts/view-mode-context';
import {
  MODE_CHAIN,
  RAIL_ITEMS,
  resolveRail,
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

const idsFor = (mode: ViewMode): RailItemId[] => resolveRail(mode).map((item) => item.id);

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
    // The Standard tier adds no rail slot of its own.
    expect(idsFor(ViewMode.Standard)).toEqual(idsFor(ViewMode.Vibe));
  });

  it('two tiers: the base rail for everyone, the developer rail with Dev on', () => {
    // Advanced was retired into Dev (2026-10-07): what Advanced added is now base,
    // so every user has data sources, RAG, automations, runs, hooks and LLM sources.
    const base = ['data-sources', 'rag', 'automations', 'process-runs', 'hooks', 'llm-sources'];
    expect(idsFor(ViewMode.Vibe)).toEqual(expect.arrayContaining(base));
    const devOnly = ['discover', 'graph-workflows', 'capabilities'];
    expect(idsFor(ViewMode.Dev)).toEqual(expect.arrayContaining(devOnly));
    for (const id of devOnly) expect(idsFor(ViewMode.Vibe)).not.toContain(id);
    // No item is declared at the retired middle tiers.
    expect(RAIL_ITEMS.map((i) => i.from).every((f) => f === ViewMode.Vibe || f === ViewMode.Dev)).toBe(true);
    // The merged ids are gone, not merely relocated.
    expect(idsFor(ViewMode.Dev)).not.toContain('triggers');
    expect(idsFor(ViewMode.Dev)).not.toContain('signals');
  });

  it('connections sits directly under the stream inbox, in every mode', () => {
    // Vibe and ungated on purpose: this screen is where the first connection is
    // made, so it must not be hidden from the mode — or the state — that needs it
    // most. Adjacency is the requested placement, so it is pinned rather than
    // left to survive the next edit to RAIL_ITEMS by luck.
    for (const mode of MODE_CHAIN) {
      const ids = idsFor(mode);
      expect(ids).toContain('credentials');
      expect(ids[ids.indexOf('credentials') - 1]).toBe('stream_inbox');
    }
  });
});

describe('resolveRail — order is the same in every mode', () => {
  const specOrder = RAIL_ITEMS.map((item) => item.id);

  for (const mode of MODE_CHAIN) {
    it(`${mode}'s rail is a subsequence of RAIL_ITEMS`, () => {
      expect(isSubsequence(idsFor(mode), specOrder)).toBe(true);
    });
  }

  it('places the top rail in the agreed order', () => {
    const top = resolveRail(ViewMode.Vibe)
      .filter((item) => item.placement === 'top')
      .map((item) => item.id);
    expect(top).toEqual(['stream_inbox', 'credentials', 'data-sources', 'rag', 'automations', 'process-runs']);
  });
});

describe('resolveRail — Stream Inbox is always reachable', () => {
  it('is on the rail in every mode, with or without conversations', () => {
    // It used to be gated on "a conversation exists". A logout purges the hub's
    // conversations, so the icon vanished in exactly the state where its screen
    // says "Login required" — the only way back in.
    for (const mode of MODE_CHAIN) expect(idsFor(mode)).toContain('stream_inbox');
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
