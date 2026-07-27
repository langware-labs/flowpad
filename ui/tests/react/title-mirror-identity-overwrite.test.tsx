/**
 * RCA capture: a restarting worker's startup OSC title (the bare program name
 * `claude`) must NOT overwrite a tag-derived session name.
 *
 * Real mechanism end-to-end:
 * - The real TabbedTerminal → TerminalPanel → InteractiveTerminal mount with a
 *   REAL xterm instance (plain MemoryRouter: the data-router's loader fetch is
 *   incompatible with this Node's undici AbortSignal, so tabs are seeded via
 *   the same `applyAllTabs` store the loader writes).
 * - PTY bytes are delivered through the SAME seam the WS uses in production
 *   (`shell.ptyConnection.routeOutput`, see FlowSync/store.ts pty_output_msg
 *   handling): real base64 chunk → real xterm OSC parse → real
 *   `term.onTitleChange` → real `handleTitleChange` gates → entity save.
 * - Only the backend boundary is faked (dataManager.callAction + apiClient),
 *   mirroring tests/react/new-agentic-tab-loader-regression.test.tsx.
 *
 * The bug manifests as a PUT of the AgenticProcess with name='claude'. The
 * control assertion (a tag title MUST still flow into a save) proves the
 * delivery pipeline is live, so the 'claude' assertion can't pass vacuously.
 */
import { render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import {
  AgenticProcess,
  apiClient,
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
import { DockPointer } from '@src/navigation/DockPointer';
import { applyAllTabs } from '@src/tabs/all-tabs-store';
import { resetTabLifecycleForTests } from '@src/tabs/tab-lifecycle';

const PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COMPUTE_NODE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PROC_ID = '11111111-1111-4111-8111-111111111111';
const SHELL_ID = '33333333-3333-4333-8333-333333333333';
const TAB_ID = '40000000-0000-4000-8000-000000000001';

/** The tag-derived name the session already has (what the bug destroys). */
const ORIGINAL_NAME = 'Fix expired invitation returning HTTP 500';
/** A later tag title — the control proving the title pipeline is live. */
const TAG_TITLE = 'Debug undelivered messages in conversation';

let TabbedTerminalComponent: typeof import('@src/components/terminal/TabbedTerminal').default;

function processDock(processId: string): DockPointer {
  return DockPointer.forShell(`${AgenticProcess.type}-${processId}`);
}

function tabRow(): TabRow {
  return {
    id: TAB_ID,
    pointer: processDock(PROC_ID).toJSON() ?? '',
    target_type: AgenticProcess.type,
    target_id: PROC_ID,
    project_id: null,
    name: ORIGINAL_NAME,
    icon_key: 'claude',
    worktree: false,
    tab_order: 0,
    last_active_at: Date.now(),
    status: 'running',
    is_disabled: false,
  };
}

function oscTitle(title: string): string {
  return `\x1b]0;${title}\x07`;
}

/** The session-less TabbedTerminal body renders ProjectHome, whose favorites
 *  mini-desktop reads react-query — the real tree gets its client from App.tsx,
 *  so the harness has to supply one too or the render throws. */
const testQueryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

function TerminalWorkspace() {
  const TabbedTerminal = TabbedTerminalComponent;
  return (
    <QueryClientProvider client={testQueryClient}>
      <div style={{ height: 320 }}>
        <TabbedTerminal className="h-full" />
      </div>
    </QueryClientProvider>
  );
}

describe('PTY title mirror vs program identity titles', () => {
  let proc: AgenticProcess;
  let shell: Shell;
  /** Every AgenticProcess name that reached the backend (PUT saves + Tab set_name). */
  let savedProcessNames: string[];
  let savedTabNames: string[];

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
    // jsdom has no layout: xterm init spins in waitForDimensions until the
    // container reports a real size.
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get: () => 800,
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get: () => 600,
    });
    if (!TabbedTerminalComponent) {
      TabbedTerminalComponent = (await import('@src/components/terminal/TabbedTerminal')).default;
    }

    window.localStorage.clear();
    await dataManager.clearCache();
    applyAllTabs([]);
    resetTabLifecycleForTests();
    const fakeSocket = { readyState: WebSocket.OPEN, send: () => {} };
    (connectionManager as unknown as { socket: Pick<WebSocket, 'readyState' | 'send'> | null }).socket = fakeSocket;
    // shell.connected (ptyConnection.isLive) requires dataContext.isConnected —
    // normally stamped by the WS 'on_open' handler.
    dataContext.connection = fakeSocket as never;

    savedProcessNames = [];
    savedTabNames = [];

    // Seed the live entities the panel renders from. Constructing them
    // registers them in the dataManager cache (APIEntity self-registration);
    // `created_by` marks them saved so save() takes the PUT path.
    proc = new AgenticProcess({
      type: AgenticProcess.type,
      id: PROC_ID,
      name: ORIGINAL_NAME,
      status: 'running',
      project_id: PROJECT_ID,
      workdir: '/tmp/flowpad-project',
      shell_id: SHELL_ID,
      worker_type: 'claude',
      auto_rename: true,
      created_by: 'test',
    } as never);
    shell = new Shell({
      type: Shell.type,
      id: SHELL_ID,
      name: 'claude shell',
      status: 'running',
      project_id: PROJECT_ID,
      workdir: '/tmp/flowpad-project',
      agentic_process_id: PROC_ID,
      pty_pid: SHELL_ID,
      created_by: 'test',
    } as never);
    // Make the transport report started+attached so InteractiveTerminal's
    // attach effect subscribes to live output — routeOutput() then notifies
    // listeners exactly as a WS pty_output_msg would.
    const conn = shell.ptyConnection as unknown as { started: boolean; _attached: boolean };
    conn.started = true;
    conn._attached = true;

    vi.spyOn(apiClient, 'put').mockImplementation(async (endpoint: string, body?: unknown) => {
      await Promise.resolve();
      const json = body as { type?: string; name?: string };
      if (typeof endpoint === 'string' && json?.type === AgenticProcess.type) {
        savedProcessNames.push(json.name ?? '');
      }
      return body as never;
    });
    vi.spyOn(apiClient, 'get').mockImplementation(async (endpoint: string) => {
      await Promise.resolve();
      // Serve entity-by-id GETs from the seeded fixtures; everything else
      // (e.g. the /pty-stream history fetch) fails → caller falls back to
      // live-only, exactly like a fresh session with no recorded stream.
      if (endpoint.includes(`/${AgenticProcess.type}/${PROC_ID}`)) return proc.toJSON() as never;
      if (endpoint.includes(`/${Shell.type}/${SHELL_ID}`)) return shell.toJSON() as never;
      throw new Error(`no REST GET in this test: ${endpoint}`);
    });
    vi.spyOn(apiClient, 'post').mockImplementation(async () => {
      await Promise.resolve();
      return {} as never;
    });

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
        return { tabs: [new Tab(tabRow())] } as never;
      }
      if (action.name === 'new_tab' && target === null) {
        return { tabs: [new Tab(tabRow())] } as never;
      }
      if (action.name === 'set_name' && target?.type === Tab.type) {
        savedTabNames.push(String((action.bodyParameters as { name?: string })?.name ?? ''));
        return { tabs: [] } as never;
      }
      if (action.name === 'open' && target?.type === AgenticProcess.type) {
        return {
          shell_id: SHELL_ID,
          pty_id: SHELL_ID,
          session_id: null,
          status: 'running',
        } as never;
      }
      if (action.name === 'activate') return {} as never;
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
      // PTY transport bookkeeping (resize / activate / ping …) — irrelevant to
      // the title path; acknowledge so void-promises don't reject.
      if (target?.type === Shell.type || target?.type === AgenticProcess.type) {
        return {} as never;
      }

      throw new Error(
        `Unexpected backend action in test: ${target?.type ?? 'none'}:${target?.id ?? 'none'}:${action.name}`,
      );
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    applyAllTabs([]);
    resetTabLifecycleForTests();
    (connectionManager as unknown as { socket: unknown }).socket = null;
    dataContext.connection = null;
    dataContext.setActiveShellId('');
    dataContext.setActiveTerminalTargetTypeId(null);
    await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId, null);
  });

  it("does not adopt the worker's startup title 'claude' over a tag-derived name", async () => {
    // Seed the tab store with the session's tab (what the route loader's
    // setupTab would have materialized) and navigate straight to it.
    applyAllTabs([new Tab(tabRow())]);

    render(
      <HarnessCapabilitiesProvider>
        <MemoryRouter initialEntries={[`/dock/shell/${AgenticProcess.type}-${PROC_ID}`]}>
          <Routes>
            <Route path="/dock/:viewType/*" element={<TerminalWorkspace />} />
          </Routes>
        </MemoryRouter>
      </HarnessCapabilitiesProvider>,
    );

    // Panel mounted and the live-output subscription is in place (the attach
    // handshake completed — same precondition a WS chunk would meet).
    await waitFor(() => {
      expect(document.querySelector('[data-testid="terminal-panel"]')).toBeInTheDocument();
    });
    const listeners = () => (shell.ptyConnection as unknown as { _listeners: Set<unknown> })._listeners.size;
    await waitFor(() => expect(listeners()).toBeGreaterThan(0), { timeout: 10000 });

    // 1. The worker (re)starts and announces itself — the CLI's real startup
    //    title escape, delivered through the production WS ingest seam.
    shell.ptyConnection.routeOutput(btoa(oscTitle('claude')), 1);

    // 2. A conversation later produces a tag title (the control signal).
    shell.ptyConnection.routeOutput(btoa(oscTitle(TAG_TITLE)), 2);

    // The control MUST arrive: proves bytes flowed through xterm's parser into
    // the title mirror. Without this, the 'claude' assertion could pass only
    // because nothing was delivered at all. Waits on the Tab set_name mirror —
    // it receives the cleaned title verbatim, so it's a stable signal in both
    // the fixed and unfixed code paths.
    await waitFor(() => expect(savedTabNames).toContain(TAG_TITLE), { timeout: 10000 });

    // THE BUG: the identity title must never have been persisted. Pre-fix the
    // mirror saves name='claude' (entity PUT + Tab set_name) the moment the
    // startup title arrives.
    expect(savedTabNames).not.toContain('claude');
    expect(savedProcessNames).not.toContain('claude');
  });
});
