import React, { useEffect, useMemo, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgenticProcess, apiClient, ComputeNode, SubAgent } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import type { VibeWorkspaceSession } from '@src/pages/flow-page/use-vibe-workspace-session';

/**
 * FLOWPAD-2045 — "click New, click a suggestion, nothing happens".
 *
 * The vibe workspace is bound to its process by the dock URL, and `New` only
 * rebinds that URL once `createProcess` has come back (~half a second on a live
 * backend). The chat panel blanks instantly, so for that whole window the user
 * is looking at what reads as an empty new session while every surface is still
 * aimed at the PREVIOUS process. A starter chip clicked there prompted the old
 * session — which, depending on what the old session was doing, misdelivered
 * the prompt, got refused server-side ("another prompt turn is already in
 * flight for this process"), or died in the client. All three looked the same,
 * because the chip's click handler dropped the promise on the floor.
 *
 * This drives the REAL surfaces through the REAL entry points: the real
 * `VibeWorkspace`, the real `VibeChatPane` behind the real `New` pill, and the
 * real `createVibeProcessForProject` — so the create-then-navigate ORDER that
 * opens the window is the product's own. The backend round trip is a deferred
 * the test holds open (that IS the in-flight window) and `openShellProcess`
 * rebinds the harness session, which is what the router does with the URL.
 */

// Hoisted with the mock factories that read them.
const { OLD_ID, NEW_ID, PROJECT_ID } = vi.hoisted(() => ({
  OLD_ID: '5e11aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  NEW_ID: '6e22bbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  PROJECT_ID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
}));

const mocks = vi.hoisted(() => ({
  openShellProcess: vi.fn(),
  openDock: vi.fn(),
  openShell: vi.fn(),
  startNewSession: vi.fn(),
  createProcess: vi.fn(),
  /** The router: whoever is mounted rebinds the workspace session id. */
  rebind: null as null | ((id: string) => void),
  /** Which process ids the URL currently resolves to an entity for. */
  hosted: new Map<string, AgenticProcess>(),
}));

vi.mock('@src/contexts/agent-context', () => ({
  useAgentContext: () => ({
    project: { id: PROJECT_ID, fs_storage_mount_path: '/workspace', name: 'proj' },
    flow: null,
  }),
}));
vi.mock('@src/navigation/useDockNavigation', () => {
  const dock = new DockPointer(ViewType.SHELL, `agentic_process-${OLD_ID}`);
  return {
    useDockNavigation: () => ({
      currentDock: dock,
      navigation: {
        openShellProcess: mocks.openShellProcess,
        openDock: mocks.openDock,
        openShell: mocks.openShell,
      },
    }),
    useCurrentDock: () => dock,
  };
});
// The URL is the binding: whatever id the session carries is the process the
// workspace resolves — the mechanism the race exploits.
vi.mock('@src/pages/flow-page/use-vibe-workspace-session', async (orig) => ({
  ...(await orig<typeof import('@src/pages/flow-page/use-vibe-workspace-session')>()),
  useVibeWorkspaceSessionHost: (session: VibeWorkspaceSession | null) =>
    (session && mocks.hosted.get(session.processId)) || null,
}));
vi.mock('@src/components/terminal/interactive-terminal/use-process-surface', () => ({
  useProcessSurface: ({ process }: { process: AgenticProcess | null }) => process,
}));
vi.mock('@src/hooks/use-agentic-process-stream', () => ({ useAgenticProcessStream: () => [] }));
vi.mock('@src/hooks/flow-hooks', () => ({
  useViewerStore: (sel: (s: { setCurrentContext: () => void }) => unknown) => sel({ setCurrentContext: () => {} }),
  useProcessWebApp: () => ({ host: null }),
  useAppDisplay: () => ({ runtime: null, available: [], src: '', port: null, microApp: null, setRuntime: vi.fn() }),
}));

// The transcript UI is a collaborator, not where the bug lives. Render the
// host's leadingSlot (the real "+ New" pill) and expose the composer gate.
vi.mock('@src/components/entity-execution-panel', () => ({
  EntityExecutionPanel: (props: Record<string, unknown>) => {
    const leadingSlot = props.leadingSlot as
      | React.ReactNode
      | ((actions: { startNewSession: () => void }) => React.ReactNode)
      | undefined;
    return (
      <div
        data-testid="exec-panel"
        data-composer-disabled={props.composerDisabled ? 'true' : 'false'}
      >
        {typeof leadingSlot === 'function' ? leadingSlot({ startNewSession: mocks.startNewSession }) : leadingSlot}
      </div>
    );
  },
}));

// Heavy display children the empty state never mounts.
vi.mock('@src/pages/flow-page/VibeAssignTaskButton', () => ({ VibeAssignTaskButton: () => null }));
vi.mock('@src/pages/flow-page/workspace-child-strip', () => ({ WorkspaceChildStrip: () => null }));
vi.mock('@src/pages/flow-page/content-panel/content-panel', () => ({ ContentPanel: () => null }));
vi.mock('@src/pages/flow-page/display-history-button', () => ({ DisplayHistoryButton: () => null }));
vi.mock('@src/components/webapp-viewer', () => ({ WebappViewer: () => null }));
vi.mock('@src/components/webapp-display/WebappDisplay', () => ({ WebappDisplay: () => null }));
vi.mock('@src/components/code-editor/CodeEditor', () => ({ default: () => null }));
vi.mock('@src/components/code-editor/DiffViewer', () => ({ default: () => null }));
vi.mock('@src/components/assets/editor/AssetEditorRouter', () => ({ AssetEditorRouter: () => null }));
vi.mock('@src/components/html-preview/HtmlPreview', () => ({ HtmlPreview: () => null }));
vi.mock('@src/components/mcp-app-preview/McpAppPreview', () => ({ McpAppPreview: () => null }));
vi.mock('@src/components/persistent-iframe', () => ({ default: () => null }));
vi.mock('@src/components/display-toolbar', () => ({
  DisplayToolbar: ({ children }: React.PropsWithChildren) => <>{children}</>,
  WebappDisplayToolbar: () => null,
}));
vi.mock('@src/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  ResizablePanel: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  ResizableHandle: () => null,
}));

import { VibeWorkspace } from '@src/pages/flow-page/vibe-workspace';

/** The router leg: `openShellProcess` moves the URL, the workspace re-binds. */
function Harness() {
  const [processId, setProcessId] = useState(OLD_ID);
  useEffect(() => {
    mocks.rebind = setProcessId;
  }, []);
  const session = useMemo<VibeWorkspaceSession>(
    () => ({
      processTab: null,
      processDock: new DockPointer(ViewType.SHELL, `agentic_process-${processId}`),
      processId,
      onProcessUrl: true,
    }),
    [processId],
  );
  return <VibeWorkspace session={session} />;
}

function makeProcess(id: string, overrides: Record<string, unknown> = {}): AgenticProcess {
  const proc = new AgenticProcess({
    id,
    project_id: PROJECT_ID,
    target_typeid_str: `project-${PROJECT_ID}`,
    ...overrides,
  });
  vi.spyOn(proc, 'prompt').mockResolvedValue(undefined as never);
  vi.spyOn(proc, 'enqueue').mockResolvedValue(undefined as never);
  vi.spyOn(proc, 'appendUserMessage');
  vi.spyOn(proc, 'watch').mockResolvedValue(undefined as never);
  vi.spyOn(proc, 'loadEmbeddedSubagent').mockResolvedValue(undefined);
  vi.spyOn(proc, 'onShow').mockReturnValue(() => {});
  vi.spyOn(proc, 'on').mockReturnValue(() => {});
  return proc;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const chips = () => screen.getAllByTestId('display-starter-chip') as HTMLButtonElement[];
const composerDisabled = () => screen.getByTestId('exec-panel').dataset.composerDisabled;

let oldProcess: AgenticProcess;
let newProcess: AgenticProcess;
let created: ReturnType<typeof deferred<AgenticProcess>>;

beforeEach(() => {
  oldProcess = makeProcess(OLD_ID);
  newProcess = makeProcess(NEW_ID);
  mocks.hosted.clear();
  mocks.hosted.set(OLD_ID, oldProcess);
  mocks.hosted.set(NEW_ID, newProcess);
  created = deferred<AgenticProcess>();
  mocks.createProcess.mockImplementation(() => created.promise);
  mocks.openShellProcess.mockImplementation((id: string) => mocks.rebind?.(id));
  vi.spyOn(ComputeNode, 'getById').mockResolvedValue({ createProcess: mocks.createProcess } as never);
  // The persona embed is I/O around the create, not part of the race.
  vi.spyOn(apiClient, 'get').mockResolvedValue([] as never);
  vi.spyOn(SubAgent, 'query').mockResolvedValue([] as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  mocks.openShellProcess.mockReset();
  mocks.openDock.mockReset();
  mocks.startNewSession.mockReset();
  mocks.createProcess.mockReset();
  mocks.rebind = null;
});

/** Let the held-open create resolve, and the navigation it triggers settle. */
async function landNewProcess() {
  await act(async () => {
    created.resolve(newProcess);
    await created.promise;
  });
}

describe('FLOWPAD-2045 — starter prompts during a New-session swap', () => {
  it('holds the chips and the composer shut until the new session owns the URL', async () => {
    render(<Harness />);
    expect(chips()[0].disabled).toBe(false);
    expect(composerDisabled()).toBe('false');

    fireEvent.click(screen.getByTestId('entity-execution-new'));

    // The window: creation is in flight, the URL still names the OLD process.
    expect(mocks.startNewSession).toHaveBeenCalled();
    expect(mocks.openShellProcess).not.toHaveBeenCalled();
    expect(chips()[0].disabled).toBe(true);
    expect(composerDisabled()).toBe('true');

    // The click the user actually makes here reaches nothing at all — before
    // the fix it landed in the old session, which is the whole bug.
    fireEvent.click(chips()[0]);
    expect(oldProcess.prompt).not.toHaveBeenCalled();

    await landNewProcess();
    await waitFor(() =>
      expect(mocks.openShellProcess).toHaveBeenCalledWith(NEW_ID, expect.anything()),
    );
    await waitFor(() => expect(chips()[0].disabled).toBe(false));
    expect(composerDisabled()).toBe('false');

    // Positive control: the chips are not merely dead. The same click now
    // prompts the session the user is actually looking at. `promptOrEnqueue`
    // forwards all three `prompt()` params positionally (undefined included),
    // hence the explicit trailing undefineds below.
    const label = chips()[0].textContent as string;
    fireEvent.click(chips()[0]);
    await waitFor(() => expect(newProcess.prompt).toHaveBeenCalledWith(label, undefined, undefined));
    expect(oldProcess.prompt).not.toHaveBeenCalled();
  });

  it('lifts the gate even when the pane unmounts while the new entity resolves', async () => {
    // The real sequence after `New`: the URL moves first and the entity for it
    // resolves a render or two later, so the workspace renders no chat pane in
    // between. Pane-local pending state would die there and leave the display
    // greyed out for good — hence the host owning the flag.
    mocks.hosted.delete(NEW_ID);
    render(<Harness />);

    fireEvent.click(screen.getByTestId('entity-execution-new'));
    expect(chips()[0].disabled).toBe(true);

    await landNewProcess();
    await waitFor(() => expect(screen.queryByTestId('exec-panel')).toBeNull());
    await waitFor(() => expect(chips()[0].disabled).toBe(false));
  });

  it('reports a refused starter prompt instead of swallowing it', async () => {
    // The server's own refusal, verbatim from the 26-Aug session log: the old
    // session was mid-turn when the prompt arrived. The user saw nothing.
    const refusal = new Error('another prompt turn is already in flight for this process');
    vi.mocked(oldProcess.prompt).mockRejectedValueOnce(refusal);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<Harness />);
    fireEvent.click(chips()[0]);

    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(
        '[Vibe] starter prompt failed',
        expect.objectContaining({ processId: OLD_ID, error: refusal }),
      ),
    );
  });

  it('enqueues a starter prompt onto a busy process instead of prompting it, with no optimistic echo', async () => {
    // The process is already mid-turn (server-confirmed `busy`, not the
    // pane's own local state) when the chip is clicked — the exact race that
    // used to fire `prompt()` straight into a 409. `submitStarterPrompt` must
    // take the same fork as ChatComposerBar.handleSend: enqueue, never prompt.
    // `appendUserMessage` is `prompt()`'s optimistic-echo primitive — asserting
    // it was never called is the "no optimistic push" half of the regression:
    // an echo with nothing to persist it would otherwise be stuck on screen
    // forever (FLOWPAD-2045).
    oldProcess = makeProcess(OLD_ID, { busy: true });
    mocks.hosted.set(OLD_ID, oldProcess);

    render(<Harness />);
    const label = chips()[0].textContent as string;
    fireEvent.click(chips()[0]);

    await waitFor(() => expect(oldProcess.enqueue).toHaveBeenCalledWith(label));
    expect(oldProcess.prompt).not.toHaveBeenCalled();
    expect(oldProcess.appendUserMessage).not.toHaveBeenCalled();
  });
});
