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
  resolveAssetVibeHost: vi.fn(),
  ensureAssetVibeParentTab: vi.fn(),
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
vi.mock('@src/tabs/vibe-parent', () => ({
  resolveAssetVibeHost: setupMocks.resolveAssetVibeHost,
  ensureAssetVibeParentTab: setupMocks.ensureAssetVibeParentTab,
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
  VibeChatPane: () => <div data-testid="vibe-chat-pane" />,
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
  setupMocks.resolveAssetVibeHost.mockReset();
  setupMocks.ensureAssetVibeParentTab.mockReset();
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

  it('shows the exact asset chat before process-tab adoption finishes', async () => {
    setupMocks.resolveAssetVibeHost.mockResolvedValue({
      process,
      projectId: '6e11aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      targetVfsPath: 'compute_node-@local/workspace/src/app.ts',
    });
    setupMocks.ensureAssetVibeParentTab.mockReturnValue(new Promise(() => {}));

    render(<AssetVibeWorkspace isVibe session={null} />);

    await waitFor(() => expect(screen.getByTestId('vibe-chat-pane')).toBeTruthy());
    expect(setupMocks.ensureAssetVibeParentTab).toHaveBeenCalledTimes(1);
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
  });

  it('URL-focuses the durable last_shown process update', async () => {
    render(<AssetVibeWorkspace isVibe session={session} />);

    act(() => {
      ConnectionManager.getInstance().emit(
        'on_data_op',
        `agentic_process-${process.id}`,
        'update',
        {
          context_data: {
            last_shown: {
              kind: 'entity',
              type: 'markdown',
              typeid: 'markdown-6e11aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            },
          },
        },
      );
    });

    await waitFor(() => expect(openDock).toHaveBeenCalledTimes(1));
    const opened = openDock.mock.calls[0][0] as DockPointer;
    expect(opened.pointer).toContain('markdown-6e11aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(opened.viewMode).toBe(ViewMode.Vibe);
  });

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

  it('replays last_shown written after mount when the transient event was missed', async () => {
    const { rerender } = render(<AssetVibeWorkspace isVibe session={session} />);
    const target = { kind: 'vfs', path: '/workspace/src/late-show.ts' };

    act(() => {
      process.context_data = {
        last_shown: target,
        display_stack: [
          {
            ...target,
            shown_at: new Date(Date.now() + 1_000).toISOString(),
          },
        ],
      };
      rerender(<AssetVibeWorkspace isVibe session={session} />);
    });

    await waitFor(() => expect(openDock).toHaveBeenCalledTimes(1));
    const opened = openDock.mock.calls[0][0] as DockPointer;
    expect(opened.pointer).toContain('late-show.ts');
    expect(opened.viewMode).toBe(ViewMode.Vibe);
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
