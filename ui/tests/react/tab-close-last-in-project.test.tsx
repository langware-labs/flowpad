/**
 * Closing the LAST tab in the active project lands on that project's HOME
 * (`navigation.openDock(DockPointer.forProject(projectId))` → ProjectBrief) — it
 * does NOT skip to a tab in ANOTHER project, even if that other tab is more
 * recently active.
 *
 * Proven lever (unified-tab-strip.tsx navigateAfterClose → resolveNextTab with the
 * current `projectId`): the next-tab pick is CONFINED to the project scope
 * (current project + projectless tabs). When the closed tab is the project's
 * last, the scoped resolve is null → land on the project home (same destination a
 * fresh project entry resolves to). The pick never falls back to the global list,
 * so another project's tab is never chosen; the global home (`closeDock`) is only
 * reached when there is no project scope at all.
 *
 * Faithful render: real <UnifiedTabStrip> + real handleClose/resolveNextTab over
 * the real all-tabs-store. Boundaries are stubbed, not the logic under test:
 * useDockNavigation (so we control the active dock + capture nav calls) and
 * useTerminalStripController (the leading/trailing chrome).
 */
import { render, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextEntitiesEnum, dataContext, dataManager, Project, Tab, type TabRow, TypeId } from '@sdk';
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

// UnifiedTabStrip reads react-router's `useNavigation()` for the in-flight nav
// target. This suite renders it outside a data router, so provide the hook's
// idle shape (no navigation in flight → `location` undefined) while keeping the
// rest of react-router real.
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return { ...actual, useNavigation: () => ({ location: undefined, state: 'idle' }) };
});

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

afterEach(async () => {
  vi.clearAllMocks();
  applyAllTabRows([]);
  await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId, null);
});

describe('closing the last tab in a project', () => {
  it('shows the no-tabs page (home) instead of jumping to another project', async () => {
    const tabA = shellTab(SHELL_A, PROJ_A, 1000, 'Tab A');
    const tabB = shellTab(SHELL_B, PROJ_B, 2000, 'Tab B'); // other project, more recent
    applyAllTabRows([tabA, tabB]);

    // The strip scopes its rendered tabs via useCurrentTabs() → the SDK context
    // project (NOT the controller's tabsProjectId). Without a current project,
    // tabA wouldn't appear in the strip and the close shortcut would no-op.
    // Establish project A as current (the same real-context path the app uses).
    dataManager.updateEntityFromJson<Project>(new Project({ id: PROJ_A, name: 'Project A' }) as never);
    await dataContext.setContextEntityTypeId(
      ContextEntitiesEnum.CurrentProjectTypeId,
      new TypeId(Project.type, PROJ_A),
    );

    // Active tab (URL) is project A's only tab.
    h.currentDock = DockPointer.fromTabHash(tabA.pointer);

    // Keep the post-navigation backend calls quiet (fire-and-forget in handleClose).
    vi.spyOn(Tab, 'closeById').mockResolvedValue([]);
    vi.spyOn(Tab, 'listAll').mockResolvedValue([]);

    render(<UnifiedTabStrip />);

    // Close the active tab via the strip's mod+W shortcut (all modifiers so the
    // platform-derived modKey matches in jsdom).
    fireEvent.keyDown(window, { key: 'w', ctrlKey: true, altKey: true, metaKey: true });

    // Expected (navigateAfterClose): the project has no tabs left, so land on the
    // PROJECT HOME (openDock(DockPointer.forProject(PROJ_A)) → ProjectBrief) — the
    // same destination a fresh project entry resolves to. It must NOT jump to
    // project B's more-recent tab, and it does NOT fall back to the global home
    // (closeDock) because a project scope is active.
    await waitFor(() => expect(h.openDock).toHaveBeenCalled());
    const dest = h.openDock.mock.calls[0][0] as DockPointer;
    expect(dest.tabHash).toBe(DockPointer.forProject(PROJ_A).tabHash);
    expect(dest.tabHash).not.toBe(DockPointer.fromTabHash(tabB.pointer).tabHash); // never project B's tab
    expect(h.closeDock).not.toHaveBeenCalled();
  });
});
