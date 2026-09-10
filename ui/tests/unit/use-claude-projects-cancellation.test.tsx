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
 * React warnings logged during this test — the thing it actually guards.
 *
 * Written as a POSITIVE match, not a deny-list. The first attempt filtered the
 * known tier noise (the `unit-tier-has-no-backend.invalid` DNS failures) and
 * then failed anyway on `WebSocket error:`, because the spy is global to the
 * vitest worker and the unit tier runs files concurrently in it — so ANY
 * unrelated async rejection lands in whatever assertion window is open, and a
 * deny-list only ever grows one pattern per new source.
 *
 * What this test is about is unmount behaviour, so it asserts that unmounting
 * logged no REACT warning ("Warning:", "not wrapped in act", "unmounted
 * component"). Foreign noise cannot make it fail; a genuine React complaint
 * still does.
 */
function reactWarnings(spy: ReturnType<typeof vi.spyOn>): unknown[][] {
  const REACT = /Warning:|not wrapped in act|unmounted component|Cannot update a component/i;
  return spy.mock.calls.filter((args) => REACT.test(args.map(String).join(' ')));
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

    expect(reactWarnings(consoleError)).toEqual([]);
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

    expect(reactWarnings(consoleError)).toEqual([]);
  });
});
