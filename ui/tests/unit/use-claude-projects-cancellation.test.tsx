import { dataManager } from '@sdk';
import {
  useClaudeProjectResources,
  useProjectList,
} from '@src/hooks/use-claude-projects';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@src/contexts/agent-context', () => ({
  useAgentContext: () => ({ computeNode: { id: '@local' } }),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

function mockAbortableAction() {
  return vi.spyOn(dataManager, 'callAction').mockImplementation(
    (action) =>
      new Promise((_resolve, reject) => {
        action.abortSignal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      }),
  );
}

describe('project hook request lifecycle', () => {
  it('aborts project listing on unmount without logging an error', async () => {
    const call = mockAbortableAction();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const hook = renderHook(() => useProjectList());

    await waitFor(() => expect(call).toHaveBeenCalledOnce());
    const signal = call.mock.calls[0][0].abortSignal;
    hook.unmount();
    await waitFor(() => expect(signal?.aborted).toBe(true));

    expect(consoleError).not.toHaveBeenCalled();
  });

  it('aborts project resource scanning on unmount without logging an error', async () => {
    const call = mockAbortableAction();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const hook = renderHook(() => useClaudeProjectResources('-work-flowpad'));

    await waitFor(() => expect(call).toHaveBeenCalledOnce());
    const signal = call.mock.calls[0][0].abortSignal;
    hook.unmount();
    await waitFor(() => expect(signal?.aborted).toBe(true));

    expect(consoleError).not.toHaveBeenCalled();
  });
});
