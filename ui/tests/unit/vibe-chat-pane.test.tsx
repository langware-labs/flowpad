import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgenticProcess } from '@sdk';
import { ViewMode } from '@src/contexts/view-mode-context';

const mocks = vi.hoisted(() => ({
  openShellProcess: vi.fn(),
  panelProps: null as Record<string, unknown> | null,
  createProcess: vi.fn().mockResolvedValue({}),
  continueProcess: vi.fn().mockResolvedValue('continued-process'),
  sourceProcess: {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    target_typeid_str: 'markdown-cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    worker_type: 'claude_code',
  },
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
            (props.onProcessSelected as ((id: string) => void) | undefined)?.('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
          }
        />
        <button
          data-testid="switch-worker"
          onClick={() =>
            (props.onActiveWorkerChange as ((args: Record<string, unknown>) => void) | undefined)?.({
              workerType: 'codex',
              activeProcess: mocks.sourceProcess,
              model: null,
              projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              workdir: '/source-workspace',
            })
          }
        />
      </>
    );
  },
}));
vi.mock('@src/pages/flow-page/VibeAssignTaskButton', () => ({
  VibeAssignTaskButton: () => null,
}));
vi.mock('@src/pages/flow-page/use-start-vibe-session', () => ({
  createVibeProcessForProject: mocks.createProcess,
  continueVibeSessionForProject: mocks.continueProcess,
  embedVibeSubagent: vi.fn().mockResolvedValue(undefined),
}));

import { VibeChatPane } from '@src/pages/flow-page/vibe-chat-pane';

afterEach(() => {
  cleanup();
  mocks.openShellProcess.mockReset();
  mocks.createProcess.mockClear();
  mocks.continueProcess.mockClear();
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
    expect(mocks.openShellProcess).toHaveBeenCalledWith('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', {
      viewMode: ViewMode.Vibe,
    });
  });

  it('offers exactly start new, continue, and cancel outcomes', () => {
    render(<VibeChatPane process={hostProcess()} />);
    fireEvent.click(screen.getByTestId('switch-worker'));

    const dialog = screen.getByTestId('vibe-worker-switch-dialog');
    expect(
      within(dialog)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Cancel', 'Start new', 'Continue this conversation']);
  });

  it('starts a blank selected-worker chat with the source target', async () => {
    render(<VibeChatPane process={hostProcess()} />);
    fireEvent.click(screen.getByTestId('switch-worker'));
    fireEvent.click(screen.getByRole('button', { name: 'Start new' }));

    await waitFor(() =>
      expect(mocks.createProcess).toHaveBeenCalledWith(
        expect.objectContaining({
          workerType: 'codex',
          targetVfsPath: mocks.sourceProcess.target_typeid_str,
        }),
      ),
    );
    expect(mocks.continueProcess).not.toHaveBeenCalled();
  });

  it('continues from the exact callback source process', async () => {
    render(<VibeChatPane process={hostProcess()} />);
    fireEvent.click(screen.getByTestId('switch-worker'));
    fireEvent.click(screen.getByRole('button', { name: 'Continue this conversation' }));

    await waitFor(() =>
      expect(mocks.continueProcess).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceProcess: mocks.sourceProcess,
          workerType: 'codex',
          targetVfsPath: mocks.sourceProcess.target_typeid_str,
        }),
      ),
    );
    expect(mocks.createProcess).not.toHaveBeenCalled();
  });

  it('cancels without creating or continuing a process', () => {
    render(<VibeChatPane process={hostProcess()} />);
    fireEvent.click(screen.getByTestId('switch-worker'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByTestId('vibe-worker-switch-dialog')).toBeNull();
    expect(mocks.createProcess).not.toHaveBeenCalled();
    expect(mocks.continueProcess).not.toHaveBeenCalled();
  });
});

function hostProcess(): AgenticProcess {
  return {
    id: '5e11aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    target_typeid_str: 'markdown-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    typeId: null,
  } as AgenticProcess;
}
