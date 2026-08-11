/**
 * The global strip on a WORKSPACE-CHILD url.
 *
 * `topLevelTabsForProject` drops every tab with a `parent_tab_id`, so the child
 * that fills the panel has no chip of its own here. Before this, `activeKey`
 * named that filtered-out child and the strip rendered with NOTHING lit — and
 * mod+PgUp/PgDn dead-ended on a `findIndex` miss. Now the highlight resolves to
 * the child's ancestor (the vibe display's process tab).
 *
 * Real <UnifiedTabStrip> + real handlers over the real all-tabs store; the
 * stubbed boundaries are useDockNavigation, useNavigation and
 * useTerminalStripController. Every row is Global-scoped (`project_id: null`) so
 * the strip needs no project context and no backend.
 */
import { render, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Tab, tabManager, type TabRow } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { resetTabContentLifecycleForTests } from '@src/tabs/tab-content-lifecycle';

const AP = '5e11aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROCESS_TAB_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHILD_TAB_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SIBLING_TAB_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const h = vi.hoisted(() => ({
  openDock: vi.fn(),
  openDockInWindow: vi.fn(),
  closeDock: vi.fn(),
  currentDock: null as DockPointer | null,
}));

vi.mock('@src/navigation/useDockNavigation', () => ({
  useCurrentDock: () => h.currentDock,
  useDockNavigation: () => ({
    navigation: { openDock: h.openDock, openDockInWindow: h.openDockInWindow, closeDock: h.closeDock },
    currentDock: h.currentDock,
  }),
}));

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return { ...actual, useNavigation: () => ({ location: undefined, state: 'idle' }) };
});

vi.mock('@src/tabs/useTerminalStripController', () => ({
  useTerminalStripController: () => ({
    // Only the fields UnifiedTabStrip actually reads.
    tabsProjectId: null,
    newTabMenuItems: [],
    closeShortcutLabel: 'Alt+W',
    leading: null,
    trailing: null,
    modals: null,
    handleStartTerminal: vi.fn(),
  }),
}));

import { UnifiedTabStrip } from '@src/pages/flow-page/content-panel/unified-tab-strip';

function row(overrides: Partial<TabRow> & Pick<TabRow, 'id' | 'pointer' | 'name'>): TabRow {
  return {
    target_type: 'shell',
    target_id: null,
    project_id: null,
    icon_key: 'shell',
    worktree: false,
    tab_order: 0,
    last_active_at: 1000,
    status: null,
    is_disabled: false,
    visible: true,
    ...overrides,
  } as TabRow;
}

/** The process tab (the vibe display) + the child it hosts + a plain sibling. */
function setupStrip() {
  const processRow = row({
    id: PROCESS_TAB_ID,
    pointer: `shell|agentic_process-${AP}`,
    target_type: 'agentic_process',
    target_id: AP,
    icon_key: 'claude',
    name: 'my agent',
  });
  const childRow = row({
    id: CHILD_TAB_ID,
    pointer: `editor|markdown-${CHILD_TAB_ID}`,
    target_type: 'markdown',
    target_id: 'md-1',
    name: 'design-doc.md',
    parent_tab_id: PROCESS_TAB_ID,
    tab_order: 1,
  });
  const siblingRow = row({
    id: SIBLING_TAB_ID,
    pointer: `shell|shell-${SIBLING_TAB_ID}`,
    target_id: SIBLING_TAB_ID,
    name: 'Sibling',
    tab_order: 2,
  });
  tabManager.adoptGlobal([processRow, childRow, siblingRow]);
  // The URL is the CHILD — the state this whole file is about.
  h.currentDock = DockPointer.fromTabHash(childRow.pointer);
  return { processRow, childRow, siblingRow };
}

const chipFor = (r: TabRow) => document.querySelector(`[data-terminal-target="${r.pointer}"]`);
const activeChips = () => document.querySelectorAll('[data-active="true"]');

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  resetTabContentLifecycleForTests();
  tabManager.adoptGlobal([]);
  h.currentDock = null;
});

describe('ancestor-active highlight in the global strip', () => {
  it('lights the ancestor chip — exactly one — while a child fills the panel', () => {
    const { processRow, childRow } = setupStrip();
    render(<UnifiedTabStrip />);

    // The child has no chip here at all; its ancestor carries the highlight and
    // shows the document.
    expect(chipFor(childRow)).toBeNull();
    expect(chipFor(processRow)?.getAttribute('data-active')).toBe('true');
    expect(chipFor(processRow)?.textContent).toContain('design-doc.md');
    expect(activeChips()).toHaveLength(1);
  });

  it('navigates away when the lit ancestor is closed', () => {
    const { processRow } = setupStrip();
    vi.spyOn(Tab, 'closeById').mockResolvedValue([]);
    vi.spyOn(Tab, 'listAll').mockResolvedValue([]);
    render(<UnifiedTabStrip />);

    // The ancestor chip is LIT, so its X is persistent rather than hover-only —
    // closing it must not strand the URL on a child whose parent just went away.
    const close = chipFor(processRow)!.querySelector('[aria-label="Close tab"]')!;
    fireEvent.click(close);

    expect(h.openDock).toHaveBeenCalled();
  });

  it('cycles from the chip the user sees lit', () => {
    const { siblingRow } = setupStrip();
    render(<UnifiedTabStrip />);

    // All modifiers at once — the strip picks one per platform.
    fireEvent.keyDown(window, { key: 'PageDown', ctrlKey: true, altKey: true, metaKey: true });

    expect(h.openDock).toHaveBeenCalledTimes(1);
    expect((h.openDock.mock.calls[0][0] as DockPointer).tabHash).toBe(siblingRow.pointer);
  });

  it('leaves mod+W a no-op on a child url (deliberate scope boundary)', () => {
    setupStrip();
    const closeById = vi.spyOn(Tab, 'closeById').mockResolvedValue([]);
    render(<UnifiedTabStrip />);

    fireEvent.keyDown(window, { key: 'w', ctrlKey: true, altKey: true, metaKey: true });

    expect(closeById).not.toHaveBeenCalled();
  });
});
