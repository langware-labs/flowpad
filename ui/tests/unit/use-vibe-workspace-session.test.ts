/**
 * useVibeWorkspaceSession — the workspace-surface resolver over the ONE-tab
 * model: a process's surface is its shell dock in both modes (vibe is a view
 * mode, not a URL family or a second tab identity).
 *
 * Case 1: a SHELL dock with an agentic_process pointer → session on the
 *         process URL (processTab may lag the store).
 * Case 2: any tab whose parent is a live process tab → child session.
 * Everything else → null.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { Tab, type ITab } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { applyAllTabs, getAllTabsSnapshot } from '@src/tabs/all-tabs-store';
import { ViewType } from '@src/types/ViewType';
import { useVibeWorkspaceSession } from '@src/pages/flow-page/use-vibe-workspace-session';

// The hook reads the current dock from useDockNavigation; pin it per-test.
let currentDock: DockPointer | null = null;
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ currentDock, navigation: {} }),
}));

beforeEach(() => {
  vi.spyOn(Tab, 'listAll').mockImplementation(async () => getAllTabsSnapshot());
});

afterEach(() => {
  currentDock = null;
  applyAllTabs([]);
  vi.restoreAllMocks();
});

const AP = '5e11aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function row(id: string, overrides: Partial<ITab> = {}): ITab {
  return {
    id,
    pointer: `{"viewType": "shell", "pointer": "agentic_process-${AP}"}`,
    target_type: 'agentic_process',
    target_id: AP,
    project_id: null,
    name: null,
    icon_key: null,
    worktree: false,
    tab_order: 0,
    last_active_at: null,
    status: null,
    is_disabled: false,
    visible: true,
    parent_tab_id: null,
    ...overrides,
  };
}

const PROCESS_TAB_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHILD_TAB_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** A workspace-child row whose stored pointer matches `dock` by tabHash (how
 *  the session hook resolves the current tab). */
const childRowFor = (dock: DockPointer) =>
  row(CHILD_TAB_ID, {
    pointer: `{"viewType": "${dock.viewType}", "pointer": "${dock.pointer}", "tabHash": "${dock.tabHash}"}`,
    target_type: 'markdown',
    target_id: 'md-child',
    parent_tab_id: PROCESS_TAB_ID,
  });

describe('useVibeWorkspaceSession', () => {
  it('Case 1: shell agentic_process dock resolves a process-URL session', () => {
    applyAllTabs([row(PROCESS_TAB_ID)]);
    currentDock = new DockPointer(ViewType.SHELL, `agentic_process-${AP}`);

    const { result } = renderHook(() => useVibeWorkspaceSession());
    expect(result.current).not.toBeNull();
    expect(result.current?.processId).toBe(AP);
    expect(result.current?.onProcessUrl).toBe(true);
    expect(result.current?.processTab?.id).toBe(PROCESS_TAB_ID);
    expect(result.current?.processDock.pointer).toBe(`agentic_process-${AP}`);
  });

  it('Case 1: session resolves with processTab null before the row lands in the store', () => {
    applyAllTabs([]);
    currentDock = new DockPointer(ViewType.SHELL, `agentic_process-${AP}`);

    const { result } = renderHook(() => useVibeWorkspaceSession());
    expect(result.current?.processId).toBe(AP);
    expect(result.current?.processTab).toBeNull();
  });

  it('a plain shell (non-process) dock with no parent is not a workspace surface', () => {
    currentDock = new DockPointer(ViewType.SHELL, 'shell-abc123');
    const { result } = renderHook(() => useVibeWorkspaceSession());
    expect(result.current).toBeNull();
  });

  it('Case 2: a plain shell CHILD resolves its parent process session', () => {
    // A terminal opened inside the workspace. It shares `ViewType.SHELL` with
    // the process dock, so Case 1 must not claim it — otherwise `build` returns
    // null on the non-process pointer and the terminal takes over the surface
    // instead of rendering in the workspace's display pane.
    currentDock = new DockPointer(ViewType.SHELL, 'shell-abc123');
    applyAllTabs([
      row(PROCESS_TAB_ID),
      { ...childRowFor(currentDock), target_type: 'shell', target_id: 'abc123' },
    ]);

    const { result } = renderHook(() => useVibeWorkspaceSession());
    expect(result.current).not.toBeNull();
    expect(result.current?.onProcessUrl).toBe(false);
    expect(result.current?.processId).toBe(AP);
    expect(result.current?.processTab?.id).toBe(PROCESS_TAB_ID);
  });

  it('Case 2: a child tab URL resolves its parent process session', () => {
    currentDock = new DockPointer(ViewType.ASSETS, 'editor/markdown/typeid/markdown-child');
    applyAllTabs([row(PROCESS_TAB_ID), childRowFor(currentDock)]);

    const { result } = renderHook(() => useVibeWorkspaceSession());
    expect(result.current).not.toBeNull();
    expect(result.current?.onProcessUrl).toBe(false);
    expect(result.current?.processId).toBe(AP);
    expect(result.current?.processTab?.id).toBe(PROCESS_TAB_ID);
  });

  it('Case 2: a child whose parent is hidden resolves no session', () => {
    currentDock = new DockPointer(ViewType.ASSETS, 'editor/markdown/typeid/markdown-child');
    applyAllTabs([row(PROCESS_TAB_ID, { visible: false }), childRowFor(currentDock)]);

    const { result } = renderHook(() => useVibeWorkspaceSession());
    expect(result.current).toBeNull();
  });
});
