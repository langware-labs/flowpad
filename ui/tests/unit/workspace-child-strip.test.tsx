/**
 * WorkspaceChildStrip — the vibe workspace's own strip over the one-tab model:
 * a fixed non-closable Display header (NOT a tab) + exactly the tabs whose
 * `parent_tab_id` is the PROCESS tab's id. Closing the active child returns to
 * the process dock (the workspace home), never an arbitrary sibling.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Tab, type ITab } from '@sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

import { DockPointer } from '@src/navigation/DockPointer';
import { applyAllTabs, getAllTabsSnapshot } from '@src/tabs/all-tabs-store';
import { ViewType } from '@src/types/ViewType';
import { TooltipProvider } from '@src/components/ui/tooltip';

const openDock = vi.fn();
let currentDock: DockPointer | null = null;
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ currentDock, navigation: { openDock } }),
  useCurrentDock: () => currentDock,
}));

import { WorkspaceChildStrip } from '@src/pages/flow-page/workspace-child-strip';

const AP = '5e11aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROCESS_TAB_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function row(id: string, overrides: Partial<ITab> = {}): ITab {
  return {
    id,
    pointer: `{"viewType": "editor", "pointer": "markdown-${id}"}`,
    target_type: 'markdown',
    target_id: `md-${id}`,
    project_id: null,
    name: `child ${id.slice(0, 4)}`,
    icon_key: null,
    worktree: false,
    tab_order: 0,
    last_active_at: null,
    status: null,
    is_disabled: false,
    visible: true,
    parent_tab_id: PROCESS_TAB_ID,
    ...overrides,
  };
}

function processTab(): Tab {
  return new Tab({
    id: PROCESS_TAB_ID,
    pointer: `{"viewType": "shell", "pointer": "agentic_process-${AP}"}`,
    target_type: 'agentic_process',
    target_id: AP,
    visible: true,
    name: 'my agent',
  });
}

const processDock = () => new DockPointer(ViewType.SHELL, `agentic_process-${AP}`);

beforeEach(() => {
  vi.spyOn(Tab, 'listAll').mockImplementation(() => Promise.resolve(getAllTabsSnapshot()));
});

afterEach(() => {
  cleanup();
  openDock.mockReset();
  currentDock = null;
  applyAllTabs([]);
  vi.restoreAllMocks();
});

describe('WorkspaceChildStrip', () => {
  it('renders only the process tab children; the Display header is not a closable tab', () => {
    const child = row('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    const foreign = row('cccccccc-cccc-4ccc-8ccc-cccccccccccc', {
      parent_tab_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    });
    const topLevel = row('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', { parent_tab_id: null });
    applyAllTabs([processTab(), child, foreign, topLevel]);

    render(
      // The Close-workspace control renders a radix Tooltip, which needs an
      // ambient TooltipProvider — the real app supplies one at its root
      // (App.tsx). Mirror that here.
      <TooltipProvider>
        <WorkspaceChildStrip processTab={processTab()} processDock={processDock()} />
      </TooltipProvider>,
    );

    expect(screen.getByTestId('workspace-display-tab')).toBeTruthy();
    expect(screen.getByText('child bbbb')).toBeTruthy();
    expect(screen.queryByText('child cccc')).toBeNull();
    expect(screen.queryByText('child eeee')).toBeNull();
  });

  it('clicking the Display header navigates to the process dock', () => {
    applyAllTabs([processTab()]);
    render(
      // The Close-workspace control renders a radix Tooltip, which needs an
      // ambient TooltipProvider — the real app supplies one at its root
      // (App.tsx). Mirror that here.
      <TooltipProvider>
        <WorkspaceChildStrip processTab={processTab()} processDock={processDock()} />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByTestId('workspace-display-tab'));
    expect(openDock).toHaveBeenCalledTimes(1);
    expect((openDock.mock.calls[0][0] as DockPointer).pointer).toBe(`agentic_process-${AP}`);
  });

  it('closing the ACTIVE child returns to the process dock', () => {
    const child = row('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    applyAllTabs([processTab(), child]);
    // Make the child the active dock so close must bounce home.
    currentDock = new DockPointer(new Tab(child).dockPointer!);
    vi.spyOn(Tab, 'closeById').mockResolvedValue([]);

    render(
      // The Close-workspace control renders a radix Tooltip, which needs an
      // ambient TooltipProvider — the real app supplies one at its root
      // (App.tsx). Mirror that here.
      <TooltipProvider>
        <WorkspaceChildStrip processTab={processTab()} processDock={processDock()} />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getAllByLabelText('Close tab')[0]);

    expect(openDock).toHaveBeenCalled();
    expect((openDock.mock.calls[0][0] as DockPointer).pointer).toBe(`agentic_process-${AP}`);
  });
});
