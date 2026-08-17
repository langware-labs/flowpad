import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

/**
 * VIBE-006 regression.
 *
 * The Vibe workspace is bound to its process by URL (`/dock/shell/
 * agentic_process-<id>`). The vibe-home creation path
 * (`createVibeProcessForProject`) does three things when it makes a process:
 *   1. embeds the SDK `vibe` persona agent (`loadEmbeddedAgent`),
 *   2. rebinds the URL to the new process (`navigation.openShellProcess`),
 *   3. enables the Flowpad Assistant.
 *
 * The in-panel `New` control instead runs `EntityExecutionPanel`'s generic
 * lazy-create and calls back through the vibe host's ONLY create hook,
 * `onProcessCreated={(p) => p.enableAssistant()}` (vibe-workspace.tsx). That
 * hook is a strict SUBSET — it enables the assistant but never embeds the vibe
 * agent and never navigates. So the new process P1 gets empty
 * `embedded_asset_refs` (facet 2) and the URL stays on P0, so a reload restores
 * P0 and discards P1's view (facet 1).
 *
 * This test drives the REAL vibe host hook (no mock of the code under test):
 * it renders the real `VibeWorkspace`, captures the `onProcessCreated` callback
 * it hands to the execution panel, invokes it with a freshly-"created" process,
 * and asserts the hook reaches parity with the vibe-home path. The generic
 * `EntityExecutionPanel` is stubbed as a collaborator (it is NOT where the bug
 * lives) purely to surface the prop the host wires into it.
 */

// Capture the props the host hands to the (stubbed) execution panel.
const panelProps = vi.hoisted(() => ({
  onProcessCreated: undefined as undefined | ((p: unknown) => unknown),
  leadingSlot: undefined as unknown,
}));

const navMocks = vi.hoisted(() => ({
  openShellProcess: vi.fn(),
  openDock: vi.fn(),
}));

// The shared vibe-persona embed is the seam both creation paths route through
// (createVibeProcessForProject and the host's create hook). Spy on it — the
// real embed resolves its ref through the backend, so asserting the low-level
// loadEmbeddedAgent would need a live server; the shared helper is the
// deterministic seam. Kept a spy so we can assert the host invokes it.
const embedMock = vi.hoisted(() => vi.fn(async () => {}));
const parentProcess = vi.hoisted(() => ({
  id: '5e11aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  target_typeid_str: 'project-proj-1',
  typeId: null,
  context_data: {},
  displayStack: [],
  onShow: vi.fn(() => () => {}),
  on: vi.fn(() => () => {}),
}));
vi.mock('@src/pages/flow-page/use-start-vibe-session', async (orig) => ({
  ...(await orig<typeof import('@src/pages/flow-page/use-start-vibe-session')>()),
  embedVibeAgent: embedMock,
}));

// The execution panel is a collaborator, not the unit under test. Render its
// leadingSlot (the vibe "New" pill) and record the host's create hook.
vi.mock('@src/components/entity-execution-panel', () => ({
  EntityExecutionPanel: (props: {
    onProcessCreated?: (p: unknown) => unknown;
    leadingSlot?: ReactNode | ((a: { startNewSession: () => void }) => ReactNode);
  }) => {
    panelProps.onProcessCreated = props.onProcessCreated;
    const slot =
      typeof props.leadingSlot === 'function' ? props.leadingSlot({ startNewSession: () => {} }) : props.leadingSlot;
    return <div data-testid="exec-panel-stub">{slot}</div>;
  },
}));

// Surrounding host dependencies — provided so the real VibeWorkspace mounts.
vi.mock('@src/contexts/agent-context', () => ({
  useAgentContext: () => ({
    project: { id: 'proj-1', fs_storage_mount_path: '/tmp/proj', name: 'proj' },
    flow: null,
  }),
}));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useCurrentDock: () => null,
  useDockNavigation: () => ({ navigation: navMocks, currentDock: null }),
}));
vi.mock('@src/hooks/flow-hooks', () => ({
  useViewerStore: (sel: (s: { setCurrentContext: () => void }) => unknown) => sel({ setCurrentContext: () => {} }),
  useProcessWebApp: () => ({ host: null }),
  useAppDisplay: () => ({
    runtime: null,
    available: [],
    src: '',
    port: null,
    microApp: null,
    setRuntime: vi.fn(),
  }),
}));
vi.mock('@src/hooks/use-agentic-process-stream', () => ({
  useAgenticProcessStream: () => [],
}));
vi.mock('@src/hooks/entity-hooks', () => ({ useEntity: () => ({ data: parentProcess }) }));
vi.mock('@src/tabs/tab-content-lifecycle', async (orig) => ({
  ...(await orig<typeof import('@src/tabs/tab-content-lifecycle')>()),
  setupTabAndAdopt: vi.fn(async () => {}),
}));

// Heavy display children the empty-state path never mounts — stubbed so the
// module graph stays light.
vi.mock('@src/components/webapp-viewer', () => ({ WebappViewer: () => null }));
vi.mock('@src/components/code-editor/CodeEditor', () => ({ default: () => null }));
vi.mock('@src/components/code-editor/DiffViewer', () => ({ default: () => null }));
vi.mock('@src/components/assets/editor/AssetEditorRouter', () => ({ AssetEditorRouter: () => null }));
vi.mock('@src/components/html-preview/HtmlPreview', () => ({ HtmlPreview: () => null }));
vi.mock('@src/components/mcp-app-preview/McpAppPreview', () => ({ McpAppPreview: () => null }));
vi.mock('@src/components/persistent-iframe', () => ({ default: () => null }));
vi.mock('@src/components/display-toolbar', () => ({
  DisplayToolbar: ({ children }: { children?: ReactNode }) => <>{children}</>,
  WebappDisplayToolbar: () => null,
}));
vi.mock('@src/pages/flow-page/display-history-button', () => ({ DisplayHistoryButton: () => null }));
vi.mock('@src/pages/flow-page/workspace-child-strip', () => ({ WorkspaceChildStrip: () => null }));
vi.mock('@src/pages/flow-page/content-panel/content-panel', () => ({ ContentPanel: () => null }));

import { VibeWorkspace } from '@src/pages/flow-page/vibe-workspace';

afterEach(() => {
  cleanup();
  panelProps.onProcessCreated = undefined;
  navMocks.openShellProcess.mockReset();
  navMocks.openDock.mockReset();
  embedMock.mockClear();
});

function makeCreatedProcess() {
  return {
    id: 'P1',
    enableAssistant: vi.fn(async () => {}),
  };
}

describe('VIBE-006 — New must reach parity with the vibe-home creation path', () => {
  it('embeds the vibe agent and rebinds the URL when the New path creates a process', async () => {
    const session = {
      processTab: null,
      processDock: {} as never,
      processId: parentProcess.id,
      onProcessUrl: true,
    };
    render(<VibeWorkspace session={session} />);

    // The vibe "New" pill mounts (host wired its leadingSlot into the panel).
    expect(screen.getByTestId('entity-execution-new')).toBeTruthy();

    const onProcessCreated = panelProps.onProcessCreated;
    expect(onProcessCreated, 'host must hand a create hook to the panel').toBeTypeOf('function');

    // Run the REAL host create hook against a freshly-created process, exactly
    // as EntityExecutionPanel.handleSend does after computeNode.createProcess.
    const created = makeCreatedProcess();
    await onProcessCreated!(created);

    // Positive control: the hook DID run (assistant enabled), proving the
    // assertions below fail on the bug, not on a dead callback.
    expect(created.enableAssistant).toHaveBeenCalled();

    // Facet 2 — attachment parity: the new process must be routed through the
    // shared vibe-persona embed, exactly like createVibeProcessForProject.
    // Currently the host hook only enables the assistant, so this is absent.
    expect(embedMock, 'New-path process must embed the vibe persona agent (attachment parity)').toHaveBeenCalledWith(
      created,
    );

    // Facet 1 — URL rebind: the workspace must navigate to the new process id
    // so the URL-derived Display binds to P1 and a reload preserves it.
    expect(
      navMocks.openShellProcess,
      'New-path must rebind the workspace URL to the new process id',
    ).toHaveBeenCalledWith('P1', expect.anything());
  });
});
