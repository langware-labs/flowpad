/**
 * Optimistic tab close: the chip leaves the strip on the SAME tick as the close
 * gesture — before the backend `tab/close` round trip resolves — and a FAILED
 * close resurfaces the chip (CloseFailed) instead of losing the tab.
 *
 * Proven lever (unified-tab-strip.tsx): the strip's working set is
 * `excludeClosingTabs(tabs, useTabLifecycles())`; `closeTabWithLifecycle` sets
 * the `Closing` lifecycle entry synchronously on invocation, so the filter
 * applies without awaiting `Tab.closeById`. Only `Closing` is filtered — a
 * rejection flips the entry to `CloseFailed` and the chip re-renders.
 *
 * Faithful render like tab-close-last-in-project.test.tsx: real
 * <UnifiedTabStrip> + real handleClose over the real all-tabs-store; stubbed
 * boundaries are useDockNavigation and useTerminalStripController.
 */
import { render, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextEntitiesEnum, dataContext, dataManager, Project, Tab, type TabRow, TypeId } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { applyAllTabRows } from '@src/tabs/all-tabs-store';
import { resetTabLifecycleForTests } from '@src/tabs/tab-lifecycle';

const PROJ_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01';
const SHELL_A = '5e11aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SHELL_B = '5e11bbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

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
    tabsProjectId: PROJ_A,
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

function shellTab(shellId: string, name: string): TabRow {
  return {
    // A real UUID id — the failure test rehydrates these rows via `new Tab(row)`,
    // which validates the entity id.
    id: shellId.replace('5e11', 'aaaa'),
    pointer: `shell|shell-${shellId}`,
    target_type: 'shell',
    target_id: shellId,
    project_id: PROJ_A,
    name,
    icon_key: 'shell',
    worktree: false,
    tab_order: 0,
    last_active_at: 1000,
    status: 'running',
    is_disabled: false,
  };
}

async function setupStrip(): Promise<{ tabA: TabRow; tabB: TabRow }> {
  const tabA = shellTab(SHELL_A, 'Tab A');
  const tabB = shellTab(SHELL_B, 'Tab B');
  applyAllTabRows([tabA, tabB]);
  dataManager.updateEntityFromJson<Project>(new Project({ id: PROJ_A, name: 'Project A' }) as never);
  await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId, new TypeId(Project.type, PROJ_A));
  h.currentDock = DockPointer.fromTabHash(tabA.pointer);
  return { tabA, tabB };
}

afterEach(async () => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  resetTabLifecycleForTests();
  applyAllTabRows([]);
  await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId, null);
});

describe('optimistic tab close', () => {
  it('removes the chip immediately, before the backend close resolves', async () => {
    await setupStrip();

    // Backend close never settles — the chip must not depend on it.
    vi.spyOn(Tab, 'closeById').mockReturnValue(new Promise<Tab[]>(() => {}));
    vi.spyOn(Tab, 'listAll').mockResolvedValue([]);

    const { queryByText } = render(<UnifiedTabStrip />);
    expect(queryByText('Tab A')).not.toBeNull();

    // Close the active tab via the strip's mod+W shortcut.
    fireEvent.keyDown(window, { key: 'w', ctrlKey: true, altKey: true, metaKey: true });

    // Synchronous assertion — no waitFor: the Closing lifecycle entry is set on
    // the same tick, so the chip is already gone while closeById is in flight.
    expect(queryByText('Tab A')).toBeNull();
    expect(queryByText('Tab B')).not.toBeNull();
  });

  it('resurfaces the chip when the backend close fails', async () => {
    const { tabA, tabB } = await setupStrip();

    vi.spyOn(Tab, 'closeById').mockRejectedValue(new Error('close failed'));
    // Backend truth after the failed close: both tabs still exist.
    vi.spyOn(Tab, 'listAll').mockResolvedValue([new Tab(tabA as never), new Tab(tabB as never)]);

    const { queryByText } = render(<UnifiedTabStrip />);
    fireEvent.keyDown(window, { key: 'w', ctrlKey: true, altKey: true, metaKey: true });
    expect(queryByText('Tab A')).toBeNull(); // optimistically hidden…

    // …but the rejection flips the entry to CloseFailed, which is NOT filtered,
    // so the chip comes back once the store settles.
    await waitFor(() => expect(queryByText('Tab A')).not.toBeNull());
  });
});
