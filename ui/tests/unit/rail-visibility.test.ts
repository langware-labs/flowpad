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

const ALL_GATES: Record<RailGate, boolean> = { project: true, conversations: true, tasks: true };

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
    expect(idsFor(ViewMode.Advanced)).toContain('triggers');
    expect(idsFor(ViewMode.Advanced)).toContain('hooks');
    expect(idsFor(ViewMode.Standard)).not.toContain('triggers');
    expect(idsFor(ViewMode.Dev)).toEqual(expect.arrayContaining(['discover', 'agentic-flows', 'capabilities']));
    expect(idsFor(ViewMode.Advanced)).not.toContain('discover');
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
    const gated = idsFor(ViewMode.Dev, { project: false, conversations: false, tasks: true });
    expect(isSubsequence(gated, specOrder)).toBe(true);
    expect(gated).not.toContain('project');
    expect(gated).not.toContain('inbox');
    expect(gated).toContain('tasks');
  });

  it('places the top rail in the agreed order', () => {
    const top = resolveRail(ViewMode.Vibe, ALL_GATES)
      .filter((item) => item.placement === 'top')
      .map((item) => item.id);
    expect(top).toEqual(['home', 'project', 'chats', 'bookmarks', 'inbox', 'tasks']);
  });
});

describe('resolveRail — content gates', () => {
  it('drops gated items when their gate is unsatisfied', () => {
    const none = idsFor(ViewMode.Dev, NO_GATES);
    expect(none).not.toContain('project');
    expect(none).not.toContain('inbox');
    expect(none).not.toContain('tasks');
    // Ungated neighbours survive.
    expect(none).toEqual(expect.arrayContaining(['home', 'chats', 'bookmarks']));
  });

  it('gates are independent — tasks content does not reveal inbox', () => {
    const tasksOnly = idsFor(ViewMode.Vibe, { project: false, conversations: false, tasks: true });
    expect(tasksOnly).toContain('tasks');
    expect(tasksOnly).not.toContain('inbox');

    const convsOnly = idsFor(ViewMode.Vibe, { project: false, conversations: true, tasks: false });
    expect(convsOnly).toContain('inbox');
    expect(convsOnly).not.toContain('tasks');
  });

  it('a fresh instance with a project shows exactly Home, Project, Chats, Bookmarks', () => {
    const top = resolveRail(ViewMode.Vibe, { project: true, conversations: false, tasks: false })
      .filter((item) => item.placement === 'top')
      .map((item) => item.id);
    expect(top).toEqual(['home', 'project', 'chats', 'bookmarks']);
  });
});

describe('RAIL_ITEMS — spec integrity', () => {
  it('has no Assets entry (the project item already opens them)', () => {
    expect(RAIL_ITEMS.find((item) => (item.id as string) === 'assets')).toBeUndefined();
  });

  it('declares each id exactly once', () => {
    const ids = RAIL_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('only declares modes that exist in the chain', () => {
    for (const item of RAIL_ITEMS) expect(MODE_CHAIN).toContain(item.from);
  });
});
