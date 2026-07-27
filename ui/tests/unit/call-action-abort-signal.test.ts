import { ActionInfo, dataManager } from '@sdk';
import apiClient from '@sdk/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DataManager.callAction abort propagation', () => {
  it('passes an AbortSignal to ordinary action requests', async () => {
    const controller = new AbortController();
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue({ ok: true });
    const action = new ActionInfo('list-projects', 'compute_node', '@local', 'GET');
    action.abortSignal = controller.signal;

    await dataManager.callAction(action);

    expect(get).toHaveBeenCalledWith(
      action.actionUrl,
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});
