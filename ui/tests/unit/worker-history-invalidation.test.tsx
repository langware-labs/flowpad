import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { connectionManager, type BroadcastMessage } from '@sdk';

const mocks = vi.hoisted(() => ({ refetch: vi.fn(async () => {}) }));

vi.mock('@src/hooks/use-action', () => ({
  useAction: () => ({ data: [], isLoading: false, refetch: mocks.refetch }),
}));
vi.mock('@src/hooks/useContext', () => ({
  useContext: () => ({
    computeNode: { typeId: { id: '00000000-0000-4000-8000-0000000000c0' } },
    activeTerminalTargetTypeId: null,
  }),
}));

import { useWorkerHistory } from '@src/hooks/useWorkerHistory';

function broadcast(broadcast_type: string) {
  act(() => connectionManager.onBroadcastMessage({ broadcast_type } as BroadcastMessage));
}

describe('worker history semantic invalidation', () => {
  afterEach(() => vi.clearAllMocks());

  it('refreshes a mounted history with no active process only for a committed history change', () => {
    const hook = renderHook(() => useWorkerHistory());
    broadcast('tabs_changed');
    for (let i = 0; i < 20; i++) {
      act(() => connectionManager.emit('on_data_op',
        'agentic_process-33333333-3333-4333-8333-333333333333', 'updated',
        { type: 'agentic_process', id: '33333333-3333-4333-8333-333333333333', status: 'running' }));
    }
    expect(mocks.refetch).not.toHaveBeenCalled();

    broadcast('worker_history_changed');
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
    hook.unmount();
    broadcast('worker_history_changed');
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
  });

  it('does not fetch disabled history and attaches when enabled', () => {
    const hook = renderHook(({ enabled }) => useWorkerHistory(10, { enabled }), {
      initialProps: { enabled: false },
    });
    broadcast('worker_history_changed');
    expect(mocks.refetch).not.toHaveBeenCalled();
    hook.rerender({ enabled: true });
    broadcast('worker_history_changed');
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
    hook.unmount();
  });
});
