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

/**
 * console.error calls that belong to THIS test.
 *
 * The spy is global to the vitest worker, and the unit tier runs files
 * concurrently in it, so an unrelated file's async XHR rejection ("getaddrinfo
 * ENOTFOUND unit-tier-has-no-backend.invalid", the tier's own no-backend
 * sentinel) lands in whatever assertion window happens to be open. Asserting
 * `not.toHaveBeenCalled()` on the raw spy therefore failed intermittently, in
 * whichever test was unlucky — it was green by timing, not by correctness.
 *
 * The guard this test actually wants is "unmounting produced no React warning",
 * so foreign network noise is filtered and everything else still fails.
 */
function ownErrors(spy: ReturnType<typeof vi.spyOn>): unknown[][] {
  const FOREIGN = /unit-tier-has-no-backend|ENOTFOUND|Service Unavailable|Backend server is not responding/i;
  return spy.mock.calls.filter((args) => !FOREIGN.test(args.map(String).join(' ')));
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

    expect(ownErrors(consoleError)).toEqual([]);
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

    expect(ownErrors(consoleError)).toEqual([]);
  });
});
