/**
 * RTL regression for the real new-session path:
 *
 * - SDK init runs through the route loader.
 * - The real router, NavigationActions, UnifiedTabStrip, TabbedTerminal,
 *   setupTab, and all-tabs-store are mounted.
 * - The user clicks the production Claude opener from the tab strip.
 *
 * The only mocked function is the SDK backend action boundary,
 * dataManager.callAction. It returns real-shaped backend payloads but does not
 * mutate the React tab store. The test currently fails at the final assertion:
 * the URL changes and setupTab materializes the Tab, but TabbedTerminal still
 * renders from a stale all-tabs-store snapshot.
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
  dataManager,
  Project,
  Shell,
  Tab,
  type ActionInfo,
  type TabRow,
} from '@sdk';
import { HarnessCapabilitiesProvider } from '@src/contexts/HarnessCapabilitiesContext';
import { DockPointer } from '@src/navigation/DockPointer';
import { loadAgentApp } from '@src/routes/loaders/main-loader';
import { applyAllTabs } from '@src/tabs/all-tabs-store';
import { resetTabLifecycleForTests } from '@src/tabs/tab-lifecycle';

const PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COMPUTE_NODE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EXISTING_PROCESS_ID = '11111111-1111-4111-8111-111111111111';
const NEW_PROCESS_ID = '22222222-2222-4222-8222-222222222222';
const NEW_SHELL_ID = '33333333-3333-4333-8333-333333333333';

let TabbedTerminalComponent: typeof import('@src/components/terminal/TabbedTerminal').default;
let UnifiedTabStripComponent: typeof import('@src/pages/flow-page/content-panel/unified-tab-strip').UnifiedTabStrip;

function processDock(processId: string): DockPointer {
  return DockPointer.forShell(`${AgenticProcess.type}-${processId}`);
}

function projectDock(): DockPointer {
  return DockPointer.forProject(PROJECT_ID);
}

function tabRow(id: string, dock: DockPointer, targetType: string | null, targetId: string | null, name: string): TabRow {
  return {
    id,
    pointer: dock.toJSON() ?? '',
    target_type: targetType,
    target_id: targetId,
    project_id: null,
    name,
    icon_key: targetType === AgenticProcess.type ? 'claude' : null,
    worktree: false,
    tab_order: 0,
    last_active_at: Date.now(),
    status: targetType === AgenticProcess.type ? 'running' : null,
    is_disabled: false,
  };
}

function processPayload(processId: string, shellId: string | null = null) {
  return {
    type: AgenticProcess.type,
    id: processId,
    name: processId === NEW_PROCESS_ID ? 'New Claude' : 'Existing Claude',
    status: 'running',
    project_id: PROJECT_ID,
    workdir: '/tmp/flowpad-project',
    shell_id: shellId,
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

function TerminalWorkspace() {
  const location = useLocation();
  const TabbedTerminal = TabbedTerminalComponent;
  const UnifiedTabStrip = UnifiedTabStripComponent;
  return (
    <div>
      <div data-testid="router-location">{location.pathname}</div>
      <UnifiedTabStrip />
      <div style={{ height: 320 }}>
        <TabbedTerminal className="h-full" />
      </div>
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
    new Capability({
      id: '10000000-0000-4000-8000-000000000002',
      kind: CapabilityKinds.Codex,
      name: 'Codex',
      last_check: available,
    }),
    new Capability({
      id: '10000000-0000-4000-8000-000000000003',
      kind: CapabilityKinds.Copilot,
      name: 'Copilot',
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

describe('new agentic-process loader handoff', () => {
  let backendTabs: Tab[];
  let releaseNewProcessOpen: (() => void) | null;
  let newProcessOpenResolved: boolean;

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
    if (!TabbedTerminalComponent) {
      TabbedTerminalComponent = (await import('@src/components/terminal/TabbedTerminal')).default;
    }
    if (!UnifiedTabStripComponent) {
      UnifiedTabStripComponent = (await import('@src/pages/flow-page/content-panel/unified-tab-strip')).UnifiedTabStrip;
    }

    window.localStorage.clear();
    await dataManager.clearCache();
    applyAllTabs([]);
    resetTabLifecycleForTests();
    seedCapabilities();
    seedConnectedWebSocket();
    releaseNewProcessOpen = null;
    newProcessOpenResolved = false;

    backendTabs = [
      new Tab(
        tabRow(
          '40000000-0000-4000-8000-000000000001',
          processDock(EXISTING_PROCESS_ID),
          AgenticProcess.type,
          EXISTING_PROCESS_ID,
          'Existing Claude',
        ),
      ),
    ];

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
        const existing = backendTabs.find((tab) => tab.pointer === pointer);
        if (!existing) {
          if (pointer === projectDock().toJSON()) {
            backendTabs = [
              ...backendTabs,
              new Tab(
                tabRow('40000000-0000-4000-8000-000000000002', projectDock(), Project.type, PROJECT_ID, 'Flowpad Project'),
              ),
            ];
          } else if (pointer === processDock(NEW_PROCESS_ID).toJSON()) {
            backendTabs = [
              ...backendTabs,
              new Tab(
                tabRow(
                  '40000000-0000-4000-8000-000000000003',
                  processDock(NEW_PROCESS_ID),
                  AgenticProcess.type,
                  NEW_PROCESS_ID,
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
        newProcessOpenResolved = true;
        return {
          shell_id: NEW_SHELL_ID,
          pty_id: `pty-${NEW_SHELL_ID}`,
          session_id: null,
          status: 'running',
          shell: shellPayload(NEW_SHELL_ID, NEW_PROCESS_ID),
        } as never;
      }

      if (action.name === 'activate') {
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

  afterEach(() => {
    vi.restoreAllMocks();
    applyAllTabs([]);
    resetTabLifecycleForTests();
    (capabilityManager as unknown as { capabilities: Capability[] }).capabilities = [];
    (connectionManager as unknown as { socket: unknown }).socket = null;
  });

  it('clicking the real Claude opener renders the newly materialized process tab', async () => {
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
    await waitFor(() => expect(screen.getByTestId('router-location')).toHaveTextContent(`/dock/project/${PROJECT_ID}`));

    const user = userEvent.setup();
    await user.click(screen.getByTestId('opener-plus-button'));
    await user.click(await screen.findByTestId('opener-menu-row-claude'));

    const expectedPath = `/dock/shell/agentic_process-${NEW_PROCESS_ID}`;
    await waitFor(() => {
      expect(window.location.pathname).toBe(expectedPath);
    });

    await waitFor(() => {
      expect(screen.getByTestId(`tab-${processDock(NEW_PROCESS_ID).tabHash}`)).toBeInTheDocument();
    });
    expect(newProcessOpenResolved).toBe(false);

    await waitFor(() => expect(releaseNewProcessOpen).toEqual(expect.any(Function)));
    releaseNewProcessOpen?.();

    await waitFor(() => {
      expect(screen.getByTestId('router-location')).toHaveTextContent(expectedPath);
    });

    await waitFor(() => {
      const activePanel = screen
        .getByTestId('terminal-panels')
        .querySelector('[data-testid="terminal-panel"][data-active="true"]');
      expect(activePanel).toHaveAttribute('data-session-id', processDock(NEW_PROCESS_ID).toJSON());
    });
  });
});
