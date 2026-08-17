/**
 * RCA repro (tab close-to-most-recently-active): selecting a tab must stamp
 * recency on the **Tab** entity the close-resolver reads — not on the backing
 * Shell/AgenticProcess row.
 *
 * The real select path runs here: the router fires the production loaders
 * (`loadAgentApp` → `loadProcess`), materializes the project-owned Tab, then
 * stamps that Tab through `stampTabRecencyForTarget`. The close resolver reads
 * the same Tab's `last_active_at`, so this test protects the full handoff.
 *
 * Faithful boundary: the only mock is the SDK backend action boundary
 * (`dataManager.callAction`), modelled on the real backend's generic `activate`
 * action (`_http_activate`), which stamps `last_active_at` on the *targeted*
 * entity row. So a Tab-targeted activate bumps that tab; a Shell/Process-
 * targeted activate does not touch any tab row — exactly the production split.
 *
 * Regression contract: the fake backend must preserve the `project_id` posted
 * by `new_tab`; otherwise exact project scoping correctly hides the fake row
 * before the recency assertion can observe the Tab-level `activate`.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router';
import {
  AgenticProcess,
  capabilityManager,
  Capability,
  CapabilityKinds,
  ComputeNode,
  ComputeProviderType,
  connectionManager,
  ContextEntitiesEnum,
  dataContext,
  dataManager,
  Project,
  Shell,
  Tab,
  type ActionInfo,
  type TabRow,
} from '@sdk';
import { HarnessCapabilitiesProvider } from '@src/contexts/HarnessCapabilitiesContext';
import { setViewMode, ViewMode } from '@src/contexts/view-mode-context';
import { DockPointer } from '@src/navigation/DockPointer';
import { loadAgentApp } from '@src/routes/loaders/main-loader';
import { tabManager } from '@sdk';
import { resetTabContentLifecycleForTests } from '@src/tabs/tab-content-lifecycle';

const PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COMPUTE_NODE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NEW_PROCESS_ID = '2a2a2a2a-2a2a-4a2a-8a2a-2a2a2a2a2a2a';
const NEW_SHELL_ID = '3a3a3a3a-3a3a-4a3a-8a3a-3a3a3a3a3a3a';
const NEW_PROCESS_TAB_ID = '4a000000-0000-4a00-8a00-00000000000a';

let TabbedTerminalComponent: typeof import('@src/components/terminal/TabbedTerminal').default;
let UnifiedTabStripComponent: typeof import('@src/pages/flow-page/content-panel/unified-tab-strip').UnifiedTabStrip;

function processDock(processId: string): DockPointer {
  return DockPointer.forShell(`${AgenticProcess.type}-${processId}`);
}

function projectDock(): DockPointer {
  return DockPointer.forProject(PROJECT_ID);
}

function tabRow(
  id: string,
  dock: DockPointer,
  targetType: string | null,
  targetId: string | null,
  projectId: string | null,
  name: string,
): TabRow {
  return {
    id,
    pointer: dock.toJSON() ?? '',
    target_type: targetType,
    target_id: targetId,
    project_id: projectId,
    name,
    icon_key: targetType === AgenticProcess.type ? 'claude' : null,
    worktree: false,
    tab_order: 0,
    // Born WITHOUT a recency seed — the only way it should become non-null is a
    // real select stamping the Tab. (The real backend `new_tab` does not seed
    // last_active_at; selection is what stamps it.)
    last_active_at: null,
    status: targetType === AgenticProcess.type ? 'running' : null,
    is_disabled: false,
  };
}

function processPayload(processId: string, shellId: string | null = null) {
  return {
    type: AgenticProcess.type,
    id: processId,
    name: 'New Claude',
    status: 'running',
    project_id: PROJECT_ID,
    workdir: '/tmp/flowpad-project',
    shell_id: shellId,
    pty_mode: true,
    visible: true,
    worker_type: 'claude',
    auto_rename: false,
  };
}

function shellPayload(shellId: string, processId: string) {
  return {
    type: Shell.type,
    id: shellId,
    name: 'New Claude Shell',
    status: 'running',
    project_id: PROJECT_ID,
    workdir: '/tmp/flowpad-project',
    agentic_process_id: processId,
    compute_node_id: null,
    auto_rename: false,
  };
}

// Only the tab strip is rendered — NOT the terminal panel. The select-stamp
// under test happens in the identity-only route loader (load-process.ts), while
// process `open` belongs to the mounted terminal panel. Skipping the panel both
// keeps this harness off xterm and proves recency does not depend on PTY start.
function TerminalWorkspace() {
  const location = useLocation();
  const UnifiedTabStrip = UnifiedTabStripComponent;
  return (
    <div>
      <div data-testid="router-location">{location.pathname}</div>
      <UnifiedTabStrip />
    </div>
  );
}

function seedCapabilities(): void {
  const available = {
    ok: true,
    available: true,
    message: 'available',
    checked_at: new Date().toISOString(),
  };
  (capabilityManager as unknown as { capabilities: Capability[] }).capabilities = [
    new Capability({
      id: '10000000-0000-4000-8000-000000000001',
      kind: CapabilityKinds.ClaudeCode,
      name: 'Claude Code',
      last_check: available,
    }),
  ];
}

function seedConnectedWebSocket(): void {
  (connectionManager as unknown as { socket: Pick<WebSocket, 'readyState' | 'send'> | null }).socket = {
    readyState: WebSocket.OPEN,
    send: () => {},
  };
}

describe('selecting a tab stamps recency on the Tab entity', () => {
  let backendTabs: Tab[];
  let releaseNewProcessOpen: (() => void) | null;
  /** Ids of Tab entities that received an `activate` action — the recency stamp. */
  let tabActivateCalls: string[];
  let recencyClock: number;

  beforeEach(async () => {
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: () => ({
        createLinearGradient: () => ({ addColorStop: () => {} }),
        createPattern: () => null,
        fillRect: () => {},
        getImageData: () => ({ data: new Uint8ClampedArray(4) }),
        measureText: () => ({ width: 0 }),
      }),
    });
    Object.defineProperty(Element.prototype, 'scrollBy', {
      configurable: true,
      value: () => {},
    });
    Object.defineProperty(Element.prototype, 'scrollTo', {
      configurable: true,
      value: () => {},
    });
    if (!TabbedTerminalComponent) {
      TabbedTerminalComponent = (await import('@src/components/terminal/TabbedTerminal')).default;
    }
    if (!UnifiedTabStripComponent) {
      UnifiedTabStripComponent = (await import('@src/pages/flow-page/content-panel/unified-tab-strip')).UnifiedTabStrip;
    }

    window.localStorage.clear();
    setViewMode(ViewMode.Advanced);
    await dataManager.clearCache();
    tabManager.adoptGlobal([]);
    resetTabContentLifecycleForTests();
    seedCapabilities();
    seedConnectedWebSocket();
    releaseNewProcessOpen = null;
    tabActivateCalls = [];
    recencyClock = 1000;

    backendTabs = [];

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
            id: PROJECT_ID,
            name: 'Flowpad Project',
            fs_storage_mount_path: '/tmp/flowpad-project',
          },
          capabilities_summary: { intents: [], capabilities: [], generated_at: new Date().toISOString() },
        } as never;
      }

      if (action.name === 'list_all' && target === null) {
        return { tabs: backendTabs.map((tab) => ({ ...tab })) } as never;
      }

      if (action.name === 'new_tab' && target === null) {
        const pointer = String(action.bodyParameters.pointer ?? '');
        const projectId = (action.bodyParameters.project_id as string | null) ?? null;
        const existing = backendTabs.find((tab) => tab.pointer === pointer);
        if (!existing) {
          if (pointer === projectDock().toJSON()) {
            backendTabs = [
              ...backendTabs,
              new Tab(
                tabRow(
                  '40000000-0000-4000-8000-000000000002',
                  projectDock(),
                  Project.type,
                  PROJECT_ID,
                  projectId,
                  'Flowpad Project',
                ),
              ),
            ];
          } else if (pointer === processDock(NEW_PROCESS_ID).toJSON()) {
            backendTabs = [
              ...backendTabs,
              new Tab(
                tabRow(
                  NEW_PROCESS_TAB_ID,
                  processDock(NEW_PROCESS_ID),
                  AgenticProcess.type,
                  NEW_PROCESS_ID,
                  projectId,
                  'New Claude',
                ),
              ),
            ];
          }
        }
        return { tabs: backendTabs.map((tab) => ({ ...tab })) } as never;
      }

      if (action.name === 'createProcess' && target?.type === ComputeNode.type) {
        return processPayload(NEW_PROCESS_ID, NEW_SHELL_ID) as never;
      }

      if (action.name === 'open' && target?.type === AgenticProcess.type && target.id === NEW_PROCESS_ID) {
        await new Promise<void>((resolve) => {
          releaseNewProcessOpen = resolve;
        });
        return {
          shell_id: NEW_SHELL_ID,
          pty_id: `pty-${NEW_SHELL_ID}`,
          session_id: null,
          status: 'running',
          shell: shellPayload(NEW_SHELL_ID, NEW_PROCESS_ID),
        } as never;
      }

      // The real backend's generic `activate` action (_http_activate) stamps
      // `last_active_at = now` on the TARGETED entity row. Model that faithfully:
      // a Tab-targeted activate bumps that tab's recency; a Shell/Process-
      // targeted activate stamps a non-Tab row, so no tab changes.
      if (action.name === 'activate') {
        if (target?.type === Tab.type && target.id) {
          tabActivateCalls.push(target.id);
          const row = backendTabs.find((t) => t.id === target.id);
          if (row) (row as unknown as { last_active_at: number }).last_active_at = ++recencyClock;
        }
        return {} as never;
      }

      if (action.name === 'get-history' && target?.type === AgenticProcess.type) {
        return { history: [], session_id: null, use_worker_history: false } as never;
      }

      if (action.name === 'input-dir' && target?.type === AgenticProcess.type) {
        return {
          abs_path: '/tmp/flowpad-project',
          compute_node_id: `${ComputeNode.type}-${COMPUTE_NODE_ID}`,
        } as never;
      }

      if (action.name === 'transcript' && target?.type === AgenticProcess.type) {
        if (action.subpath === 'plan') return { markdown: null, plan_path: null } as never;
        if (action.subpath === 'prompts') return { prompts: [] } as never;
        if (action.subpath === 'full') return { entries: [] } as never;
      }

      if (action.name === 'fs' && target?.type === ComputeNode.type) {
        return [] as never;
      }

      throw new Error(`Unexpected backend action in test: ${target?.type ?? 'none'}:${target?.id ?? 'none'}:${action.name}`);
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    tabManager.adoptGlobal([]);
    resetTabContentLifecycleForTests();
    (capabilityManager as unknown as { capabilities: Capability[] }).capabilities = [];
    (connectionManager as unknown as { socket: unknown }).socket = null;
    setViewMode(ViewMode.Vibe);
    // Reset the shared dataContext the loader mutated (active shell/target +
    // current project) so a following loader-integration test in the SAME worker
    // doesn't inherit this test's active terminal target — cross-test
    // contamination that makes the second-to-run test fail in the full suite even
    // though each passes in isolation.
    dataContext.setActiveShellId('');
    dataContext.setActiveTerminalTargetTypeId(null);
    await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId, null);
  });

  it('stamps last_active_at on the process Tab when it is selected', async () => {
    const router = createMemoryRouter(
      [
        {
          path: '/dock/:viewType/*',
          loader: loadAgentApp,
          element: <TerminalWorkspace />,
        },
      ],
      { initialEntries: [`/dock/project/${PROJECT_ID}`] },
    );

    render(
      <HarnessCapabilitiesProvider>
        <RouterProvider router={router} />
      </HarnessCapabilitiesProvider>,
    );

    await screen.findByTestId('terminal-tab-bar');

    const user = userEvent.setup();
    await user.click(screen.getByTestId('opener-plus-button'));
    await user.click(await screen.findByTestId('opener-menu-row-claude'));

    const expectedPath = `/dock/shell/agentic_process-${NEW_PROCESS_ID}`;
    await waitFor(() => expect(screen.getByTestId('router-location')).toHaveTextContent(expectedPath));

    // The process tab materialized in the strip — the select path has run.
    await waitFor(() => {
      expect(screen.getByTestId(`tab-${processDock(NEW_PROCESS_ID).tabHash}`)).toBeInTheDocument();
    });
    // No panel mounted means no runtime start; route identity + recency still
    // completed. This protects the loader/view ownership boundary too.
    expect(releaseNewProcessOpen).toBeNull();

    // The crux: selecting the process tab must have stamped recency on the TAB
    // entity (an `activate` to the Tab). Today the loader only activates the
    // AgenticProcess, so the Tab is never stamped — this is the bug.
    await waitFor(() => {
      expect(tabActivateCalls).toContain(NEW_PROCESS_TAB_ID);
    });
    const processTab = backendTabs.find((t) => t.id === NEW_PROCESS_TAB_ID);
    expect(processTab?.last_active_at).not.toBeNull();
  });
});
