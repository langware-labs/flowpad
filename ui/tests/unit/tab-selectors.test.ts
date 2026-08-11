import { describe, expect, it } from 'vitest';
import { Tab } from '@sdk';
import {
  childrenOfTab,
  displayAncestorForDockKey,
  isWorkspaceChild,
  openTabHashes,
  openTabTargetIds,
  parentOfTab,
  projectTabCounts,
  tabForDockKey,
  tabForTargetId,
  tabHasRecency,
  tabIsProcess,
  tabKey,
  tabsForProject,
  topLevelTabsForProject,
  uniqueTabsByDockKey,
} from '@sdk/tabs';

let tabIdCounter = 0;

function nextTabId(): string {
  tabIdCounter += 1;
  return `30000000-0000-4000-8000-${String(tabIdCounter).padStart(12, '0')}`;
}

function tab(
  label: string,
  overrides: Partial<Tab> = {},
): Tab {
  const id = nextTabId();
  const result = new Tab({
    id,
    pointer: JSON.stringify({ viewType: 'shell', pointer: `shell-${id}` }),
    target_type: 'shell',
    target_id: `target-${label}`,
    visible: true,
  });
  Object.assign(result, {
    parent_tab_id: null,
    project_id: null,
    tab_order: 0,
    last_active_at: null,
    ...overrides,
  });
  return result;
}

describe('tab selectors', () => {
  it('uses Tab.getKey and deduplicates by dock key without changing order', () => {
    const first = tab('first');
    const duplicate = tab('duplicate', { pointer: first.pointer });
    const last = tab('last');

    expect(tabKey(first)).toBe(first.getKey());
    expect(uniqueTabsByDockKey([first, duplicate, last])).toEqual([first, last]);
  });

  it('projects exact project scope and removes workspace children only at top level', () => {
    const parent = tab('parent', { project_id: 'project-a', target_type: 'agentic_process' });
    const child = tab('child', { project_id: 'project-a', parent_tab_id: parent.id });
    const other = tab('other', { project_id: 'project-b' });
    const global = tab('global');

    expect(tabsForProject([parent, child, other, global], 'project-a')).toEqual([parent, child]);
    expect(topLevelTabsForProject([parent, child, other, global], 'project-a')).toEqual([parent]);
    expect(topLevelTabsForProject([parent, child, other, global], null)).toEqual([global]);
    expect(isWorkspaceChild(parent)).toBe(false);
    expect(isWorkspaceChild(child)).toBe(true);
  });

  it('returns only visible children of the requested parent in backend order', () => {
    const first = tab('first', { parent_tab_id: 'parent' });
    const hidden = tab('hidden', { parent_tab_id: 'parent', visible: false });
    const second = tab('second', { parent_tab_id: 'parent' });
    const foreign = tab('foreign', { parent_tab_id: 'other' });

    expect(childrenOfTab([first, hidden, second, foreign], 'parent')).toEqual([first, second]);
  });

  it('resolves a child to its parent, and to null for every un-parentable case', () => {
    const parent = tab('parent');
    const child = tab('child', { parent_tab_id: parent.id });
    const topLevel = tab('top');
    const orphan = tab('orphan', { parent_tab_id: 'no-such-row' });
    const closedParent = tab('closed', { visible: false });
    const childOfClosed = tab('child-of-closed', { parent_tab_id: closedParent.id });

    expect(parentOfTab([parent, child], child)).toBe(parent);
    // A top-level tab has no parent; nor does a nullish tab.
    expect(parentOfTab([parent, topLevel], topLevel)).toBeNull();
    expect(parentOfTab([parent], null)).toBeNull();
    // Dangling edge, and a parent outside the list passed in (e.g. another
    // project's strip) — both degrade to "no ancestor", never a throw.
    expect(parentOfTab([parent, orphan], orphan)).toBeNull();
    expect(parentOfTab([child], child)).toBeNull();
    // A soft-closed parent is not a usable ancestor.
    expect(parentOfTab([closedParent, childOfClosed], childOfClosed)).toBeNull();
  });

  it('resolves the displayed ancestor only when the active child is omitted', () => {
    const parent = tab('parent');
    const child = tab('child', { parent_tab_id: parent.id });

    expect(displayAncestorForDockKey([parent], [parent, child], child.getKey())).toEqual({
      parent,
      child,
    });
    expect(displayAncestorForDockKey([parent, child], [parent, child], child.getKey())).toBeNull();
    expect(displayAncestorForDockKey([parent], [parent], child.getKey())).toBeNull();
  });

  it('finds tabs and derives open sets from canonical dock/target identity', () => {
    const first = tab('first');
    const bare = tab('bare', { pointer: '', target_id: null });

    expect(tabForDockKey([first, bare], tabKey(first))).toBe(first);
    expect(tabForDockKey([first], null)).toBeNull();
    expect(tabForTargetId([first, bare], first.target_id!)).toBe(first);
    expect(openTabHashes([first, bare])).toEqual(new Set([first.getKey()]));
    expect(openTabTargetIds([first, bare])).toEqual(new Set([first.target_id]));
  });

  it('recognizes process tabs and numeric or legacy ISO recency stamps', () => {
    expect(tabIsProcess(tab('process', { target_type: 'agentic_process' }))).toBe(true);
    expect(tabIsProcess(tab('shell'))).toBe(false);
    expect(tabHasRecency(tab('numeric', { last_active_at: 42 }))).toBe(true);
    expect(tabHasRecency(tab('iso', { last_active_at: '2025-01-01T00:00:00Z' }))).toBe(true);
    expect(tabHasRecency(tab('invalid', { last_active_at: 'not-a-date' }))).toBe(false);
  });

  it('counts every real tab including children, while excluding project hosts', () => {
    const projectA = tab('a-content', { project_id: 'project-a' });
    const child = tab('a-child', { project_id: 'project-a', parent_tab_id: 'parent' });
    const host = tab('a-host', {
      project_id: 'project-a',
      target_type: 'project',
      target_id: 'project-a',
    });
    const projectB = tab('b-content', { project_id: 'project-b', target_type: 'markdown' });
    const global = tab('global');

    const result = projectTabCounts([projectA, child, host, projectB, global]);
    expect(result.counts).toEqual(new Map([['project-a', 2], ['project-b', 1]]));
    expect(result.globalTabCount).toBe(1);
  });
});
