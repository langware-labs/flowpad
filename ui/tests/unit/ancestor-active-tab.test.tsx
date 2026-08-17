/**
 * The global strip filters workspace children out (`topLevelTabsForProject`), so
 * on a child URL it used to render with NOTHING lit. `useAncestorActiveTab`
 * resolves the chip that stands in for the child — the vibe display — and
 * the strip owner presents the child's mapped icon + title without changing
 * the parent chip's identity or actions.
 *
 * The guard under test throughout: the resolution fires ONLY when the raw active
 * key names no chip in the list, so exactly one chip is ever active and the
 * strips that already render the child themselves (sessions view `scope='all'`,
 * the workspace child strip) are untouched.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { Tab, tabKey, tabManager, type ITab } from '@sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

import { DockPointer } from '@src/navigation/DockPointer';
import { ALL_SCOPE_FILTER } from '@src/lib/scope-filter';

let currentDock: DockPointer | null = null;
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ currentDock, navigation: { openDock: vi.fn() } }),
  useCurrentDock: () => currentDock,
}));

import { TabStrip } from '@src/components/tabs/TabStrip';
import { useTabStripItems } from '@src/tabs/tab-row-item';
import { useAncestorActiveTab } from '@src/tabs/use-tab-manager';

const AP = '5e11aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROCESS_TAB_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHILD_TAB_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** The process tab — the vibe display's one row, and the ancestor under test. */
function processTab(): Tab {
  return new Tab({
    id: PROCESS_TAB_ID,
    pointer: `{"viewType": "shell", "pointer": "agentic_process-${AP}"}`,
    target_type: 'agentic_process',
    target_id: AP,
    icon_key: 'claude',
    visible: true,
    name: 'my agent',
  });
}

function childTab(overrides: Partial<ITab> = {}): Tab {
  return new Tab({
    id: CHILD_TAB_ID,
    pointer: `{"viewType": "editor", "pointer": "markdown-${CHILD_TAB_ID}"}`,
    target_type: 'markdown',
    target_id: 'md-1',
    visible: true,
    name: 'design-doc.md',
    parent_tab_id: PROCESS_TAB_ID,
    ...overrides,
  } as ITab);
}

function Strip({ tabs }: { tabs: Tab[] }) {
  const ancestor = useAncestorActiveTab(tabs, currentDock?.tabHash);
  const baseItems = useTabStripItems(tabs);
  const childItems = useTabStripItems(ancestor ? [ancestor.child] : []);
  const childItem = childItems[0];
  const items = baseItems.map((item) =>
    ancestor && childItem && item.key === tabKey(ancestor.parent)
      ? { ...item, standsFor: { icon: childItem.icon, title: childItem.title } }
      : item,
  );
  return <TabStrip items={items} activeKey="" onSelect={() => {}} onClose={() => {}} />;
}

// This file covers the CHIP CONTENT half. The highlight half lives in
// `tests/unit/ancestor-active-strip.test.tsx`, because the active key is
// resolved by `UnifiedTabStrip`, not by `useTabStripItems`.

afterEach(() => {
  cleanup();
  currentDock = null;
  tabManager.adoptGlobal([]);
  vi.restoreAllMocks();
});

describe('ancestor-active display chip', () => {
  it('shows the active child on the ancestor chip, and renames the ancestor', () => {
    const parent = processTab();
    const child = childTab();
    tabManager.adoptGlobal([parent, child]);
    currentDock = new DockPointer(child.dockPointer!);

    // Only the parent is in the strip's list — exactly what the global strip
    // passes, since `topLevelTabsForProject` drops the child.
    render(<Strip tabs={[parent]} />);

    expect(screen.getByText('design-doc.md')).toBeTruthy();
    expect(screen.queryByText('my agent')).toBeNull();
    // Identity stays the parent's: the chip is still keyed — and therefore
    // selected, closed and renamed — as the PROCESS row.
    expect(screen.getByTestId(`tab-${tabKey(parent)}`)).toBeTruthy();
  });

  it('grafts the LIVE dock title, not the child row\'s frozen name', () => {
    const parent = processTab();
    // A scope-keyed Assets child freezes its stored name at creation; the live
    // overlay is the only thing that knows which document is open.
    const dock = DockPointer.forAssetEditor(
      'markdown',
      '/Users/test/project/docs/interface.md',
    ).withScopeFilter(ALL_SCOPE_FILTER);
    const child = childTab({
      pointer: dock.toJSON() ?? '',
      name: "Test's Assets",
      target_type: null,
      target_id: null,
    });
    tabManager.adoptGlobal([parent, child]);
    currentDock = dock;

    render(<Strip tabs={[parent]} />);

    expect(screen.getByText('interface.md')).toBeTruthy();
    expect(screen.queryByText("Test's Assets")).toBeNull();
  });

  it('stays inert when the strip already renders the child (sessions view)', () => {
    const parent = processTab();
    const child = childTab();
    tabManager.adoptGlobal([parent, child]);
    currentDock = new DockPointer(child.dockPointer!);

    // `scope='all'` keeps children, so the child has its OWN chip — grafting
    // here would show the same document twice, on two chips.
    render(<Strip tabs={[parent, child]} />);

    // The process chip keeps its own name; the document is on the child's chip.
    expect(screen.getByText('my agent')).toBeTruthy();
    expect(screen.getByText('design-doc.md')).toBeTruthy();
  });

  it('degrades to nothing lit when the ancestor is unreachable', () => {
    const parent = processTab();
    const orphan = childTab({ parent_tab_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' });
    tabManager.adoptGlobal([parent, orphan]);
    currentDock = new DockPointer(orphan.dockPointer!);

    render(<Strip tabs={[parent]} />);

    expect(screen.getByText('my agent')).toBeTruthy();
    expect(screen.queryByText('design-doc.md')).toBeNull();
  });
});
