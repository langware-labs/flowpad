import React, {
  forwardRef,
  useImperativeHandle,
  useState,
  type PropsWithChildren,
} from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgenticProcess, ConnectionManager, fsStore, TypeId, VFSPath } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import { ViewMode } from '@src/contexts/view-mode-context';

let currentDock = new DockPointer(ViewType.EDITOR, '/workspace/src/app.ts');
const openDock = vi.fn();
const setupMocks = vi.hoisted(() => ({
  setupTabAndAdopt: vi.fn().mockResolvedValue(undefined),
}));
let showListener: ((target: Record<string, unknown>) => void) | null = null;
let entityEventListener:
  | ((event: string, payload: Record<string, unknown>) => void)
  | null = null;
const process = new AgenticProcess({
  id: '5e11aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  target_typeid_str: 'compute_node-@local/workspace/src/app.ts',
});
vi.spyOn(process, 'on').mockImplementation(
  ((event: string, listener: (...args: unknown[]) => void) => {
    if (event === 'show') showListener = listener;
    if (event === 'entity_event') entityEventListener = listener;
    return () => {};
  }) as typeof process.on,
);

vi.mock('@src/contexts/agent-context', () => ({
  useAgentContext: () => ({
    computeNode: { typeId: new TypeId('compute_node', '@local') },
  }),
}));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ currentDock, navigation: { openDock } }),
  // view-mode-context reads the dock directly, so a partial mock of this
  // module made every consumer of it throw "No useCurrentDock export".
  useCurrentDock: () => currentDock,
}));
vi.mock('@src/tabs/tab-content-lifecycle', async (orig) => ({
  ...(await orig<typeof import('@src/tabs/tab-content-lifecycle')>()),
  setupTabAndAdopt: setupMocks.setupTabAndAdopt,
}));
vi.mock('@src/pages/flow-page/use-vibe-workspace-session', async () => {
  const actual = await vi.importActual<
    typeof import('@src/pages/flow-page/use-vibe-workspace-session')
  >('@src/pages/flow-page/use-vibe-workspace-session');
  return {
    ...actual,
    useVibeWorkspaceSessionHost: (activeSession: VibeWorkspaceSession | null) =>
      activeSession ? process : null,
  };
});
vi.mock('@src/pages/flow-page/vibe-chat-pane', () => ({
  VibeChatPane: ({ process: bound }: { process: AgenticProcess | null }) => (
    <div data-testid="vibe-chat-pane" data-process={bound?.id ?? ''} />
  ),
}));
vi.mock('@src/pages/flow-page/workspace-child-strip', () => ({
  WorkspaceChildStrip: () => <div data-testid="workspace-child-strip" />,
}));
vi.mock('@src/pages/flow-page/content-panel/content-panel', () => ({
  ContentPanel: ({ minimalChrome }: { minimalChrome?: boolean }) => {
    const [value, setValue] = useState('');
    return (
      <input
        data-testid="sentinel-editor"
        data-minimal={minimalChrome ? 'true' : 'false'}
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
    );
  },
}));
vi.mock('@src/components/ui/resizable', () => {
  interface MockPanelProps extends PropsWithChildren {
    className?: string;
    id?: string;
    [key: string]: unknown;
  }
  const Panel = forwardRef<
    { collapse: () => void; expand: () => void },
    MockPanelProps
  >(({ children, className, id }, ref) => {
    useImperativeHandle(ref, () => ({ collapse: vi.fn(), expand: vi.fn() }));
    return <div className={className} id={id}>{children}</div>;
  });
  return {
    ResizablePanelGroup: ({ children }: PropsWithChildren) => <div>{children}</div>,
    ResizablePanel: Panel,
    ResizableHandle: ({
      className,
      children,
    }: PropsWithChildren<{ className?: string }>) => (
      <div className={className}>{children}</div>
    ),
  };
});

import { AssetVibeWorkspace } from '@src/pages/flow-page/asset-vibe-workspace';
import type { VibeWorkspaceSession } from '@src/pages/flow-page/use-vibe-workspace-session';

const session: VibeWorkspaceSession = {
  processId: process.id,
  processDock: new DockPointer(ViewType.SHELL, `agentic_process-${process.id}`),
  processTab: null,
  onProcessUrl: false,
};

afterEach(() => {
  cleanup();
  currentDock = new DockPointer(ViewType.EDITOR, '/workspace/src/app.ts');
  openDock.mockReset();
  setupMocks.setupTabAndAdopt.mockClear();
  showListener = null;
  entityEventListener = null;
  process.context_data = {};
});

describe('AssetVibeWorkspace', () => {
  it('preserves the same dirty editor instance across Standard → Vibe', () => {
    const { rerender } = render(
      <AssetVibeWorkspace isVibe={false} session={session} />,
    );
    const editor = screen.getByTestId('sentinel-editor');
    fireEvent.change(editor, { target: { value: 'unsaved text' } });

    rerender(<AssetVibeWorkspace isVibe session={session} />);

    expect(screen.getByTestId('sentinel-editor')).toBe(editor);
    expect(screen.getByDisplayValue('unsaved text')).toBe(editor);
    expect(editor.dataset.minimal).toBe('true');
    expect(screen.getByTestId('vibe-chat-pane')).toBeTruthy();
  });

  it('offers session creation without inventing a host for a standalone document', () => {
    // A document's home is its asset address. What used to happen here was a
    // project resolve, a query for a Chat discussing this asset, and CREATING a
    // process when none matched — which is why a reload could land on a
    // different process than the one that showed it. The host is now a fact of
    // the URL, so its absence simply means "just a document".
    render(<AssetVibeWorkspace isVibe session={null} />);

    // The existing start action is offered; opening alone does not create a session.
    expect(screen.getByTestId('vibe-start-new-chat')).toBeTruthy();
    expect(screen.queryByTestId('vibe-chat-pane')).toBeNull();
    expect(screen.queryByTestId('workspace-child-strip')).toBeNull();
    expect(setupMocks.setupTabAndAdopt).not.toHaveBeenCalled();
  });

  it('URL-focuses a new asset shown by the same parent process', async () => {
    render(<AssetVibeWorkspace isVibe session={session} />);
    expect(showListener).not.toBeNull();

    act(() => showListener?.({ kind: 'vfs', path: '/workspace/src/next.ts' }));

    await waitFor(() => expect(openDock).toHaveBeenCalledTimes(1));
    // URL-first: the destination loader materializes/adopts the child tab.
    expect(setupMocks.setupTabAndAdopt).not.toHaveBeenCalled();
    const opened = openDock.mock.calls[0][0] as DockPointer;
    expect(opened.pointer).toContain('next.ts');
    expect(opened.viewMode).toBe(ViewMode.Vibe);
    // Flagged as the workspace's REPLACEABLE display: the agent's next show
    // re-points this one row instead of minting a chip per show.
    expect(opened.isActiveDisplay).toBe(true);
  });

  // The second delivery channel (`dataManager.on('on_entity_event')`, which closes
  // the late-WS-attach race) is deliberately NOT covered here: this tier installs no
  // SDK manager, which is the very condition the component guards on, so a test of it
  // would assert the guard rather than the behavior. It is exercised in the api tier.

  it('keeps an explicit history URL instead of replaying older last_shown state', () => {
    process.context_data = {
      last_shown: { kind: 'vfs', path: '/workspace/public/latest.html' },
      display_stack: [
        {
          kind: 'vfs',
          path: '/workspace/public/latest.html',
          shown_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    };

    render(<AssetVibeWorkspace isVibe session={session} />);

    expect(openDock).not.toHaveBeenCalled();
  });

  it('does not navigate on a durable last_shown update — restore is the loader\'s job', async () => {
    // The inverse of what this file used to assert, and deliberately so. The
    // workspace once replayed `context_data.last_shown` on any process update, with
    // a mount-time baseline to stop it re-firing. That baseline existed because a
    // durable pin has no memory of whether the user already dealt with it.
    //
    // The URL is that memory now: a cold landing is restored once, in
    // `restoreDisplayRedirect`, guarded by the workspace's own active-display row.
    // If this test ever fails, a replay channel has been reintroduced and closed
    // displays will start coming back on reload.
    const { rerender } = render(<AssetVibeWorkspace isVibe session={session} />);
    const target = { kind: 'vfs', path: '/workspace/src/late-show.ts' };

    act(() => {
      process.context_data = {
        last_shown: target,
        display_stack: [{ ...target, shown_at: new Date(Date.now() + 1_000).toISOString() }],
      };
      rerender(<AssetVibeWorkspace isVibe session={session} />);
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(openDock).not.toHaveBeenCalled();
  });

  it('invalidates a live parent-process file write through FSStore', () => {
    render(<AssetVibeWorkspace isVibe session={session} />);
    expect(entityEventListener).not.toBeNull();
    const computeNode = new TypeId('compute_node', '@local');
    const path = '/workspace/src/app.ts';
    const fsPath = VFSPath.fromMachinePath(path, computeNode).entitySubPath;
    const before = fsStore.getState().getRevision(computeNode, fsPath);

    act(() => entityEventListener?.('file.write', { path }));

    expect(fsStore.getState().getRevision(computeNode, fsPath)).toBeGreaterThan(before);
  });
});
