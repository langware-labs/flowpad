import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgenticProcess } from '@sdk';
import { ViewMode } from '@src/contexts/view-mode-context';

const mocks = vi.hoisted(() => ({
  openShellProcess: vi.fn(),
  panelProps: null as Record<string, unknown> | null,
}));

vi.mock('@src/contexts/agent-context', () => ({
  useAgentContext: () => ({
    project: {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      fs_storage_mount_path: '/workspace',
    },
  }),
}));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({
    navigation: { openShellProcess: mocks.openShellProcess },
  }),
}));
vi.mock('@src/components/entity-execution-panel', () => ({
  EntityExecutionPanel: (props: Record<string, unknown>) => {
    mocks.panelProps = props;
    return (
      <>
        <button
          data-testid="pick-history"
          onClick={() =>
            (props.onProcessSelected as ((id: string) => void) | undefined)?.(
              'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            )
          }
        />
      </>
    );
  },
}));
vi.mock('@src/pages/flow-page/VibeAssignTaskButton', () => ({
  VibeAssignTaskButton: () => null,
}));
vi.mock('@src/pages/flow-page/VibeCollaborateButton', () => ({
  VibeCollaborateButton: () => null,
}));
vi.mock('@src/pages/flow-page/use-start-vibe-session', () => ({
  embedVibeAgent: vi.fn().mockResolvedValue(undefined),
}));

import { VibeChatPane } from '@src/pages/flow-page/vibe-chat-pane';

afterEach(() => {
  cleanup();
  mocks.openShellProcess.mockReset();
  mocks.panelProps = null;
});

describe('VibeChatPane', () => {
  it('binds history to the parent target and rebinds selection through navigation', () => {
    const process = {
      id: '5e11aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      target_typeid_str: 'markdown-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      typeId: null,
    } as AgenticProcess;

    render(<VibeChatPane process={process} />);

    expect(mocks.panelProps?.target).toBe(process.target_typeid_str);
    expect(mocks.panelProps?.initialProcessId).toBe(process.id);
    fireEvent.click(screen.getByTestId('pick-history'));
    expect(mocks.openShellProcess).toHaveBeenCalledWith(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      { viewMode: ViewMode.Vibe },
    );
  });
});
