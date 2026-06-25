/**
 * Regression: opening a tab in a SECOND project must not erase the FIRST
 * project from the active-projects chip (ProjectsCounterChip / useTabProjectBuckets).
 *
 * Real-flow reproduction of the cross-project clobber:
 *   - Project A already owns a terminal tab (the chip shows 1 project: A).
 *   - The user opens a terminal that lives in Project B. The REAL route loader
 *     (loadAgentApp → setupTabAndAdopt → setupTab → materializeTab) runs, which
 *     for a brand-new dock calls Tab.getFromDockPointer → Tab.newTab(projectId=B).
 *   - The backend `new_tab` action returns the PROJECT-FILTERED list
 *     ({B} + projectless) — faithfully emulated here exactly as the server's
 *     `_http_new_tab → _list_response(project_id)` does.
 *   - setupTabAndAdopt adopts that scoped list into the GLOBAL all-tabs store via
 *     applyAllTabs(), clobbering Project A's tab.
 *
 * Result the bug produces: the bucket list collapses to ONLY Project B.
 * Expected (correct) behaviour: BOTH A and B are present.
 *
 * The only mocked function is the SDK backend action boundary
 * (dataManager.callAction), returning real-shaped payloads that mirror the real
 * server contract — list_all is GLOBAL, new_tab is PROJECT-SCOPED. The frontend
 * logic under test (loader, materializeTab, all-tabs-store, useTabProjectBuckets)
 * runs for real; the broken state emerges from that real flow, not by hand.
 */
import {
  AgenticProcess,
  ComputeNode,
  ComputeProviderType,
  connectionManager,
  dataManager,
  Project,
  type ActionInfo,
  type TabRow,
} from '@sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DockPointer } from '@src/navigation/DockPointer';
import { loadAgentApp } from '@src/routes/loaders/main-loader';
import { applyAllTabs } from '@src/tabs/all-tabs-store';
import { resetTabLifecycleForTests } from '@src/tabs/tab-lifecycle';
import { useTabProjectBuckets } from '@src/tabs/useTabs';

const PROJECT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJECT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const COMPUTE_NODE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PROC_A = '11111111-1111-4111-8111-111111111111';
const PROC_B = '22222222-2222-4222-8222-222222222222';
const TAB_A = '40000000-0000-4000-8000-000000000001';
const TAB_B = '40000000-0000-4000-8000-000000000002';

function processDock(processId: string): DockPointer {
  return DockPointer.forShell(`${AgenticProcess.type}-${processId}`);
}

function tabRow(id: string, dock: DockPointer, processId: string, projectId: string): TabRow {
  return {
    id,
    pointer: dock.toJSON() ?? '',
    target_type: AgenticProcess.type,
    target_id: processId,
    project_id: projectId,
    name: `Claude ${processId.slice(0, 4)}`,
    icon_key: 'claude',
    worktree: false,
    tab_order: 0,
    last_active_at: Date.now(),
    status: 'running',
    is_disabled: false,
  };
}

function processPayload(processId: string, projectId: string) {
  return {
    type: AgenticProcess.type,
    id: processId,
    name: `Claude ${processId.slice(0, 4)}`,
    status: 'running',
    project_id: projectId,
    workdir: '/tmp/flowpad-project',
    shell_id: null,
    worker_type: 'claude',
    auto_rename: false,
  };
}

/** Mirror the server's `_list_response(project)`: GLOBAL order filtered to
 *  `{project} + projectless` (filter_for_project). This IS the contract the
 *  real backend's new_tab/list handlers return. */
function listResponse(db: TabRow[], project: string | null): { tabs: TabRow[] } {
  const filtered = db.filter((t) => t.project_id === project || t.project_id == null);
  return { tabs: filtered.map((t) => ({ ...t })) };
}

function seedConnectedWebSocket(): void {
  (connectionManager as unknown as { socket: Pick<WebSocket, 'readyState' | 'send'> | null }).socket = {
    readyState: WebSocket.OPEN,
    send: () => {},
  };
}

describe('active-projects chip — opening a tab in project B must not drop project A', () => {
  let db: TabRow[];

  beforeEach(async () => {
    window.localStorage.clear();
    await dataManager.clearCache();
    applyAllTabs([]);
    resetTabLifecycleForTests();
    seedConnectedWebSocket();

    // Two real Project entities, so buckets resolve without per-project network.
    dataManager.updateEntityFromJson<Project>(new Project({ id: PROJECT_A, name: 'Project A' }) as never);
    dataManager.updateEntityFromJson<Project>(new Project({ id: PROJECT_B, name: 'Project B' }) as never);

    // Two real AgenticProcess entities, so getFromDockPointer reads each tab's
    // project_id straight from the target (cache hit, no network).
    dataManager.updateEntityFromJson<AgenticProcess>(
      new AgenticProcess(processPayload(PROC_A, PROJECT_A) as never) as never,
    );
    dataManager.updateEntityFromJson<AgenticProcess>(
      new AgenticProcess(processPayload(PROC_B, PROJECT_B) as never) as never,
    );

    // Backend DB starts with Project A's terminal tab only. Project B's tab does
    // not exist yet — opening it will fire the real new_tab create path.
    db = [tabRow(TAB_A, processDock(PROC_A), PROC_A, PROJECT_A)];

    vi.spyOn(dataManager, 'callAction').mockImplementation(async (action: ActionInfo) => {
      const target = action.targetEntity;
      await Promise.resolve();

      if (action.name === 'bootstrap') {
        return {
          types: [],
          visitor: { type: 'visitor', id: 'visitor-1', name: 'Test Visitor' },
          default_compute_node: {
            type: ComputeNode.type,
            id: COMPUTE_NODE_ID,
            name: 'Local Test',
            runtime: { name: 'test' },
            node_provider_type: ComputeProviderType.LOCAL_MACHINE,
            fs_storage_mount_path: '/tmp/flowpad-project',
          },
          default_project: {
            type: Project.type,
            id: PROJECT_A,
            name: 'Project A',
            fs_storage_mount_path: '/tmp/flowpad-project',
          },
          capabilities_summary: { intents: [], capabilities: [], generated_at: new Date().toISOString() },
        } as never;
      }

      // GLOBAL projection — every visible tab, all projects (server _http_list_all).
      if (action.name === 'list_all' && target === null) {
        return { tabs: db.map((t) => ({ ...t })) } as never;
      }

      // PROJECT-SCOPED projection — server _http_new_tab → _list_response(project_id).
      if (action.name === 'new_tab' && target === null) {
        const pointer = String(action.bodyParameters.pointer ?? '');
        const projectId = (action.bodyParameters.project_id as string | null) ?? null;
        if (!db.some((t) => t.pointer === pointer)) {
          if (pointer === processDock(PROC_B).toJSON()) {
            db = [...db, tabRow(TAB_B, processDock(PROC_B), PROC_B, PROJECT_B)];
          }
        }
        return listResponse(db, projectId) as never;
      }

      // Anything else the loader touches (process/project resolution, content
      // route load) is irrelevant to the clobber, which happens at adoption time
      // BEFORE content setup. loadDockPointer swallows its own errors, so a
      // benign empty keeps the real flow moving without masking the bug.
      return {} as never;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    applyAllTabs([]);
    resetTabLifecycleForTests();
    (connectionManager as unknown as { socket: unknown }).socket = null;
  });

  it('keeps both projects in the bucket list after opening project B', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const router = createMemoryRouter(
      [
        {
          path: '/dock/:viewType/*',
          loader: loadAgentApp,
          element: <div />,
        },
      ],
      { initialEntries: [`/dock/shell/${AgenticProcess.type}-${PROC_A}`] },
    );

    // Mount the REAL bucket hook (reads the global all-tabs store) up front, so a
    // later store change reflects via applyAllTabs and never via a fresh
    // list_all refetch that would mask the clobber.
    const { result } = renderHook(() => useTabProjectBuckets(), { wrapper });

    render(<RouterProvider router={router} />);

    // After the initial load, Project A owns the only tab → exactly one bucket.
    await waitFor(() => {
      expect(result.current.buckets.map((b) => b.projectId).sort()).toEqual([PROJECT_A]);
    });

    // Open Project B's terminal through the real loader.
    await router.navigate(`/dock/shell/${AgenticProcess.type}-${PROC_B}`);

    // The backend now holds both tabs (2 projects) — verify the global contract
    // is correct, so the assertion below pins a PURELY frontend regression.
    await waitFor(() => {
      const projectsInDb = [...new Set(db.filter((t) => t.project_id).map((t) => t.project_id))].sort();
      expect(projectsInDb).toEqual([PROJECT_A, PROJECT_B].sort());
    });

    // The chip must still list BOTH projects. The bug collapses it to [B].
    await waitFor(() => {
      expect(result.current.buckets.map((b) => b.projectId).sort()).toEqual([PROJECT_A, PROJECT_B].sort());
    });
  });
});
