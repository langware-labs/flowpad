import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';

vi.mock('@src/contexts/agent-context', () => ({
  useAgentContext: () => ({
    computeNode: null,
    project: null,
  }),
}));

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({
    currentDock: new DockPointer(ViewType.EDITOR, '/workspace/src/app.ts'),
    navigation: { openDock: vi.fn() },
  }),
}));

vi.mock('@src/pages/flow-page/use-vibe-workspace-session', () => ({
  useVibeWorkspaceSessionHost: () => null,
}));

vi.mock('@src/components/terminal/interactive-terminal/use-process-surface', () => ({
  useProcessSurface: () => undefined,
}));

vi.mock('@src/tabs/tab-content-lifecycle', async (orig) => ({
  ...(await orig<typeof import('@src/tabs/tab-content-lifecycle')>()),
  setupTabAndAdopt: vi.fn(),
}));

// Ambient: the workspace now always mounts its display chrome (the toolbar stays
// in the tree across a mode toggle so the editor beneath it is never remounted),
// and that pulls the SDK's react context in. Nothing here is under test.
vi.mock('@sdk/react/hooks', async (orig) => ({
  ...(await orig<typeof import('@sdk/react/hooks')>()),
  useEntityOps: () => undefined,
}));

vi.mock('@src/pages/flow-page/content-panel/content-panel', () => ({
  ContentPanel: () => <div data-testid="asset-content" />,
}));

vi.mock('@src/pages/flow-page/vibe-chat-pane', () => ({
  VibeChatPane: () => <div data-testid="vibe-chat-pane" />,
}));

vi.mock('@src/pages/flow-page/workspace-child-strip', () => ({
  WorkspaceChildStrip: () => <div data-testid="workspace-child-strip" />,
}));

import { AssetVibeWorkspace } from '@src/pages/flow-page/asset-vibe-workspace';

function expectPanelSizes(container: HTMLElement, chat: string, content: string) {
  expect(container.querySelector('[data-panel-id="asset-vibe-chat"]')?.getAttribute('data-panel-size')).toBe(chat);
  expect(container.querySelector('[data-panel-id="asset-vibe-content"]')?.getAttribute('data-panel-size')).toBe(
    content,
  );
}

describe('AssetVibeWorkspace panel layout', () => {
  it('mounts and transitions against the real panel primitive after layout initialization', () => {
    let view: ReturnType<typeof render> | undefined;
    expect(() => {
      view = render(
        <React.StrictMode>
          <AssetVibeWorkspace isVibe={false} session={null} />
        </React.StrictMode>,
      );
    }).not.toThrow();
    expect(screen.getByTestId('asset-content')).toBeTruthy();
    expectPanelSizes(view!.container, '0.0', '100.0');

    expect(() => {
      view?.rerender(
        <React.StrictMode>
          <AssetVibeWorkspace isVibe session={null} />
        </React.StrictMode>,
      );
    }).not.toThrow();
    expect(screen.getByTestId('vibe-chat-pane')).toBeTruthy();
    expectPanelSizes(view!.container, '36.0', '64.0');

    expect(() => {
      view?.rerender(
        <React.StrictMode>
          <AssetVibeWorkspace isVibe={false} session={null} />
        </React.StrictMode>,
      );
    }).not.toThrow();
    expectPanelSizes(view!.container, '0.0', '100.0');
    view?.unmount();
  });

  it('mounts directly in Vibe mode at the intended split', () => {
    const { container, unmount } = render(
      <React.StrictMode>
        <AssetVibeWorkspace isVibe session={null} />
      </React.StrictMode>,
    );
    expectPanelSizes(container, '36.0', '64.0');
    unmount();
  });
});
