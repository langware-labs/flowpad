/**
 * A local deployment's process panel: the terminal its file runs in (by the process's shell id), a
 * header saying whether it runs, a minimize that folds it to its header and is remembered, and a
 * Restart that only asks the deployment to restart.
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Deployment, DeploymentProcess } from '@sdk';

vi.mock('@src/components/terminal/interactive-terminal/SidecarShellTerminal', () => ({
  SidecarShellTerminal: ({ shellId }: { shellId: string }) => <div data-testid="terminal" data-shell={shellId} />,
}));
vi.mock('@monaco-editor/react', () => ({ default: () => null, loader: { init: () => Promise.resolve({}) } }));
vi.mock('@src/components/code-editor/shikiMonaco', () => ({ ensureShikiMonaco: () => Promise.resolve(), monacoTheme: () => 'x' }));
vi.mock('@sdk/react/hooks', () => ({ useOnTag: () => undefined }));

import { DeploymentProcessPanel } from '@src/components/assets/editor/agent-profile/deployment/DeploymentProcessPanel';

function deployment(process: Partial<DeploymentProcess> = {}) {
  const value: DeploymentProcess = {
    deployment_id: 'd1', shell_id: 'sh-1', file: '/x/d1.py', command: 'python /x/d1.py d1', pid: 4242, serving: true, ...process,
  };
  return {
    id: 'd1',
    process: vi.fn().mockResolvedValue(value),
    code: vi.fn().mockResolvedValue({ file: value.file, text: 'print(1)' }),
    saveCode: vi.fn(),
    restart: vi.fn().mockResolvedValue(value),
  } as unknown as Deployment & { restart: ReturnType<typeof vi.fn> };
}

async function renderPanel(d: Deployment) {
  render(<DeploymentProcessPanel deployment={d} />);
  await act(async () => undefined);
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('deployment process panel', () => {
  it("shows the terminal its file runs in, and that it runs", async () => {
    await renderPanel(deployment());
    expect(screen.getByTestId('terminal')).toHaveAttribute('data-shell', 'sh-1');
    expect(screen.getByTestId('deployment-process-state')).toHaveTextContent('Running · pid 4242');
  });

  it('says stopped when nothing runs it', async () => {
    await renderPanel(deployment({ pid: null }));
    expect(screen.getByTestId('deployment-process-state')).toHaveTextContent('Stopped');
  });

  it('minimizes to its header, and remembers it', async () => {
    await renderPanel(deployment());
    fireEvent.click(screen.getByTestId('deployment-process-toggle'));
    expect(screen.queryByTestId('terminal')).toBeNull();
    expect(screen.getByTestId('deployment-process-panel')).toHaveAttribute('data-minimized', 'true');
    cleanup();

    await renderPanel(deployment());
    expect(screen.queryByTestId('terminal')).toBeNull();
  });

  it('Restart asks the deployment to restart — nothing else', async () => {
    const d = deployment();
    await renderPanel(d);
    await act(async () => {
      fireEvent.click(screen.getByTestId('deployment-process-restart'));
    });
    expect(d.restart).toHaveBeenCalledTimes(1);
  });
});
