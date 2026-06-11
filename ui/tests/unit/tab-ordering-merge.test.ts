/**
 * Phase-0 characterization: locks the current tab ORDERING + MERGE invariant of
 * the tabs store (now `useTabs`) before the TabManager refactor. See the plan
 * (`mergePreservingOrder`, `byTabOrder`). Pure functions — no module state.
 *
 * The most important case here is the "index-0 trap" regression: on the FIRST
 * fetch the server order is adopted and any pre-seeded `prev` is discarded, so a
 * loader-seeded tab is NOT trapped at index 0.
 *
 * Entity ids must be valid v4/v5 UUIDs (TypeId enforces the entity-id policy),
 * so each readable label maps to a fixed valid UUID via `uid`.
 */
import { describe, expect, it } from 'vitest';
import { byTabOrder, mergePreservingOrder } from '@src/tabs/useTabs';
import { procTab, shellTab } from '../utils/terminal-tab-fixtures';

describe('byTabOrder', () => {
  it('sorts by ascending tabOrder', () => {
    const sorted = [shellTab('a', 2), shellTab('b', 0), shellTab('c', 1)].sort(byTabOrder);
    expect(sorted.map((t) => t.name)).toEqual(['b', 'c', 'a']);
  });

  it('breaks ties with plain shells before processes', () => {
    const sorted = [procTab('p', 0), shellTab('s', 0)].sort(byTabOrder);
    expect(sorted.map((t) => t.type)).toEqual(['plain', 'claude']);
  });
});

describe('mergePreservingOrder — first fetch (firstFetchCompleted=false)', () => {
  it('adopts server order and DISCARDS prev (index-0 trap regression)', () => {
    const prev = [shellTab('seed', 0)]; // a loader-seeded tab
    const fetched = [shellTab('b', 2), shellTab('c', 0)];
    const merged = mergePreservingOrder(prev, fetched, false);
    // seed is gone; result is purely the server set sorted by tabOrder
    expect(merged.map((t) => t.name)).toEqual(['c', 'b']);
  });
});

describe('mergePreservingOrder — subsequent fetch (firstFetchCompleted=true)', () => {
  it('keeps existing tabs in their local order, refreshed in place', () => {
    const prev = [shellTab('a', 0, { statusReason: 'old' }), shellTab('b', 1, { statusReason: 'old' })];
    const fetched = [shellTab('b', 1, { statusReason: 'fresh' }), shellTab('a', 0, { statusReason: 'fresh' })];
    const merged = mergePreservingOrder(prev, fetched, true);
    // prev order preserved (a, b), but values come from the fetched (refreshed) objects
    expect(merged.map((t) => t.name)).toEqual(['a', 'b']);
    expect(merged.map((t) => t.statusReason)).toEqual(['fresh', 'fresh']);
  });

  it('drops removed tabs', () => {
    const prev = [shellTab('a', 0), shellTab('b', 1)];
    const fetched = [shellTab('a', 0)];
    const merged = mergePreservingOrder(prev, fetched, true);
    expect(merged.map((t) => t.name)).toEqual(['a']);
  });

  it('appends new tabs at the end, sorted among themselves by tabOrder', () => {
    const prev = [shellTab('a', 0)];
    const fetched = [shellTab('a', 0), shellTab('b', 5), shellTab('c', 1)];
    const merged = mergePreservingOrder(prev, fetched, true);
    // 'a' stays first (existing); new b/c appended sorted by tabOrder → c, b
    expect(merged.map((t) => t.name)).toEqual(['a', 'c', 'b']);
  });
});
