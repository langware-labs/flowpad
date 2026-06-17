/**
 * Reproduces: closing the LAST tab in the active project navigates to home
 * (closeDock) instead of switching to the most-recently-active tab in ANOTHER
 * project.
 *
 * Proven lever (unified-tab-strip.tsx handleClose): the next-tab pick uses the
 * project-SCOPED `rows` (current project + projectless), not the global
 * `allRows`. When the closed tab is the project's last, the scoped resolve is
 * null → `navigation.closeDock()` (home). Falling back to `allRows` would
 * resolve the other project's tab.
 *
 * Faithful render: real <UnifiedTabStrip> + real handleClose/resolveNextTabRow
 * over the real all-tabs-store. Boundaries are stubbed, not the logic under
 * test: useDockNavigation (so we control the active dock + capture nav calls)
 * and useTerminalStripController (the leading/trailing chrome). Regression
 * guard: close now resolves over the GLOBAL list (preferring the current
 * project), so the project's last tab skips to project B instead of Home.
 */
import { render, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Tab, type TabRow } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { applyAllTabRows } from '@src/tabs/all-tabs-store';

const PROJ_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01';
const PROJ_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb02';
const SHELL_A = '5e11aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SHELL_B = '5e11bbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const h = vi.hoisted(() => ({
  openDock: vi.fn(),
  openDockInWindow: vi.fn(),
  closeDock: vi.fn(),
  currentDock: null as DockPointer | null,
}));

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({
    navigation: { openDock: h.openDock, openDockInWindow: h.openDockInWindow, closeDock: h.closeDock },
    currentDock: h.currentDock,
  }),
}));

vi.mock('@src/tabs/useTerminalStripController', () => ({
  useTerminalStripController: () => ({
    tabsProjectId: PROJ_A, // strip is scoped to project A
    newTabMenuItems: [],
    closeShortcutLabel: 'Alt+W',
    leading: null,
    trailing: null,
    modals: null,
    isTabCreationPending: false,
    isClaudeCreationPending: false,
    isTerminalCreationPending: false,
    handleStartClaude: vi.fn(),
    handleStartTerminal: vi.fn(),
    handleOpenHistory: vi.fn(),
  }),
}));

import { UnifiedTabStrip } from '@src/pages/flow-page/content-panel/unified-tab-strip';

function shellTab(shellId: string, projectId: string, lastActive: number, name: string): TabRow {
  return {
    id: `tab-${shellId.slice(0, 8)}`,
    pointer: `shell|shell-${shellId}`,
    target_type: 'shell',
    target_id: shellId,
    project_id: projectId,
    name,
    icon_key: 'shell',
    worktree: false,
    tab_order: 0,
    last_active_at: lastActive,
    status: 'running',
    is_disabled: false,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  applyAllTabRows([]);
});

describe('closing the last tab in a project', () => {
  it('switches to the most-recently-active tab in another project (not home)', () => {
    const tabA = shellTab(SHELL_A, PROJ_A, 1000, 'Tab A');
    const tabB = shellTab(SHELL_B, PROJ_B, 2000, 'Tab B'); // other project, more recent
    applyAllTabRows([tabA, tabB]);

    // Active tab (URL) is project A's only tab.
    h.currentDock = DockPointer.fromTabHash(tabA.pointer);

    // Keep the post-navigation backend calls quiet (fire-and-forget in handleClose).
    vi.spyOn(Tab, 'closeById').mockResolvedValue([]);
    vi.spyOn(Tab, 'listAll').mockResolvedValue([]);

    render(<UnifiedTabStrip />);

    // Close the active tab via the strip's mod+W shortcut (all modifiers so the
    // platform-derived modKey matches in jsdom).
    fireEvent.keyDown(window, { key: 'w', ctrlKey: true, altKey: true, metaKey: true });

    // Expected: navigate to project B's tab. (Today: closeDock → home.)
    expect(h.openDock).toHaveBeenCalledWith(
      expect.objectContaining({ pointer: `shell-${SHELL_B}` }),
    );
    expect(h.closeDock).not.toHaveBeenCalled();
  });
});
