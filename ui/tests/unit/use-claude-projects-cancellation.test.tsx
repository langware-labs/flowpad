import { dataManager, lazyAssets } from '@sdk';
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
  lazyAssets.setScope(Math.random().toString());
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
  it('keeps a shared project listing alive on unmount and aborts on identity change', async () => {
    const call = mockAbortableAction();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const hook = renderHook(() => useProjectList());

    await waitFor(() => expect(call).toHaveBeenCalledOnce());
    const signal = call.mock.calls[0][0].abortSignal;
    hook.unmount();
    expect(signal?.aborted).toBe(false);
    lazyAssets.setScope(Math.random().toString());
    await waitFor(() => expect(signal?.aborted).toBe(true));

    expect(consoleError).not.toHaveBeenCalled();
  });

  it('keeps a shared project scan alive on unmount and aborts on identity change', async () => {
    const call = mockAbortableAction();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const hook = renderHook(() => useClaudeProjectResources('-work-flowpad'));

    await waitFor(() => expect(call).toHaveBeenCalledOnce());
    const signal = call.mock.calls[0][0].abortSignal;
    hook.unmount();
    expect(signal?.aborted).toBe(false);
    lazyAssets.setScope(Math.random().toString());
    await waitFor(() => expect(signal?.aborted).toBe(true));

    expect(consoleError).not.toHaveBeenCalled();
  });
});
