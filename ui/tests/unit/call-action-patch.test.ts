import { ActionInfo, dataManager } from '@sdk';
import apiClient from '@sdk/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const TRIGGER_ID = '14fd60c5-91b1-4c23-8378-34f9e7265b11';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DataManager.callAction PATCH transport', () => {
  it('sends the action body with PATCH instead of falling through to GET', async () => {
    const patch = vi.spyOn(apiClient, 'patch').mockResolvedValue({ id: TRIGGER_ID });
    const get = vi.spyOn(apiClient, 'get');
    const action = new ActionInfo('update', 'trigger', TRIGGER_ID, 'PATCH');
    action.bodyParameters = { name: 'Edited schedule' };

    await dataManager.callAction(action);

    expect(patch).toHaveBeenCalledWith(
      action.actionUrl,
      { name: 'Edited schedule' },
      undefined,
    );
    expect(get).not.toHaveBeenCalled();
  });
});
