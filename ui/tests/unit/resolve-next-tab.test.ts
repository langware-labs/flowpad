/**
 * `resolveNextTab` (tab-candidates.ts) — the loader-side default-tab pick,
 * now routed through the single `resolveActive` resolver (tab-management.md
 * Part 1 §5, Phase 3: retires `resolveDefaultTab`).
 *
 * INTENTIONAL PRECEDENCE CHANGE vs the retired `resolveDefaultTab`
 * (characterized in the previous revision of this file as
 * resolve-default-tab.test.ts):
 *   old: dataContext.activeTerminalTargetTypeId → dataContext.activeShellId
 *        → first pickable tab (list order)
 *   new: pending intent (consume-once) → recency (max lastActiveAt)
 *        → lowest tabOrder
 * The previous-target preference is expressed by the recency tier: every
 * loader load stamps the loaded entity (`bumpLastActive` + server `activate`),
 * so the previously-active tab is exactly the max-recency member.
 *
 * "Pickable" exclusions are UNCHANGED: not disabled and not in `excludeIds`
 * (by target string, target id, transport shell id, or owning process id) —
 * filtered BEFORE resolving, so an excluded tab can never win any tier.
 *
 * Entity ids must be valid v4/v5 UUIDs (TypeId enforces the entity-id policy).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Shell } from '@sdk';
import { resolveNextTab } from '@src/tabs/tab-candidates';
import { peekPendingIntent, setPendingIntent } from '@src/tabs/pending-intent';
import { type TerminalTab } from '@src/tabs/useTabs';
import { procTab, shellTab, uid } from '../utils/terminal-tab-fixtures';

beforeEach(() => setPendingIntent(null));
afterEach(() => setPendingIntent(null));

/** A shell tab whose cached Shell entity carries a recency stamp. */
function recentShellTab(label: string, lastActiveAt: number | null, tabOrder = 0): TerminalTab {
  return shellTab(label, tabOrder, {
    shell: (lastActiveAt == null ? {} : { last_active_at: lastActiveAt }) as unknown as Shell,
  });
}

describe('resolveNextTab — resolveActive precedence', () => {
  it('picks the lowest tabOrder when there is no intent and no recency', () => {
    // (Old behavior was "first in list order"; the resolver uses tabOrder.)
    const tabs = [shellTab('b', 2), shellTab('a', 1)];
    expect(resolveNextTab(tabs)?.name).toBe('a');
  });

  it('prefers the most-recently-active tab over tabOrder (Bug 1 tier)', () => {
    const tabs = [recentShellTab('a', 1_000, 0), recentShellTab('b', 2_000, 5)];
    expect(resolveNextTab(tabs)?.name).toBe('b');
  });

  it('expresses the old previous-target preference via recency: the last-loaded tab wins', () => {
    // bumpLastActive stamps the loaded entity on every loader load — so the
    // previously-active tab is the max-recency member, replacing the old
    // dataContext.activeTerminalTargetTypeId / activeShellId tiers.
    const tabs = [recentShellTab('a', 1_000), recentShellTab('prev', Date.now())];
    expect(resolveNextTab(tabs)?.name).toBe('prev');
  });

  it('an explicit pending intent wins over recency and is consumed', () => {
    const a = recentShellTab('a', Date.now());
    const b = shellTab('b', 9);
    setPendingIntent(b.targetTypeId.toString());
    expect(resolveNextTab([a, b])?.name).toBe('b');
    expect(peekPendingIntent()).toBeNull(); // consumed — decided the pick
  });

  it('an intent for a non-member is ignored and NOT consumed', () => {
    const tabs = [shellTab('a', 1)];
    setPendingIntent(`shell-${uid('elsewhere')}`);
    expect(resolveNextTab(tabs)?.name).toBe('a');
    expect(peekPendingIntent()).toBe(`shell-${uid('elsewhere')}`);
  });

  it('an intent for an EXCLUDED tab cannot win (candidates filtered first) and is not consumed', () => {
    const a = shellTab('a', 1);
    const b = shellTab('b', 2);
    setPendingIntent(a.targetTypeId.toString());
    expect(resolveNextTab([a, b], new Set([uid('a')]))?.name).toBe('b');
    expect(peekPendingIntent()).toBe(a.targetTypeId.toString());
  });
});

describe('resolveNextTab — pickability exclusions (unchanged)', () => {
  it('skips disabled tabs', () => {
    const tabs = [shellTab('a', 0, { isDisabled: true }), shellTab('b', 1)];
    expect(resolveNextTab(tabs)?.name).toBe('b');
  });

  it('skips tabs whose target id is excluded', () => {
    const tabs = [shellTab('a', 0), shellTab('b', 1)];
    expect(resolveNextTab(tabs, new Set([uid('a')]))?.name).toBe('b');
  });

  it('skips a process tab whose owning process id is excluded', () => {
    const tabs = [procTab('p1', 0, { shellId: uid('s1') }), shellTab('b', 1)];
    expect(resolveNextTab(tabs, new Set([uid('p1')]))?.name).toBe('b');
  });

  it('skips a process tab whose transport shell id is excluded', () => {
    const tabs = [procTab('p1', 0, { shellId: uid('s1') }), shellTab('b', 1)];
    expect(resolveNextTab(tabs, new Set([uid('s1')]))?.name).toBe('b');
  });

  it('returns null when nothing is pickable', () => {
    const tabs = [shellTab('a', 0, { isDisabled: true })];
    expect(resolveNextTab(tabs)).toBeNull();
    expect(resolveNextTab([])).toBeNull();
  });
});
