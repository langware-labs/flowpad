import { ActionInfo, dataManager, Tab } from '@sdk';
import apiClient from '@sdk/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const TAB_ID = '6a1f2c9e-4b7d-4e2a-9c3f-8d5e1b0a7c64';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DataManager.callAction keepalive transport', () => {
  it('sends a keepalive action on the fetch adapter so a page unload cannot abort it', async () => {
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({});
    const action = new ActionInfo('close', 'tab', TAB_ID, 'POST');
    action.keepalive = true;

    await dataManager.callAction(action);

    expect(post).toHaveBeenCalledWith(action.actionUrl, action.bodyParameters, {
      adapter: 'fetch',
      fetchOptions: { keepalive: true },
    });
  });

  it('leaves an ordinary action on the default transport', async () => {
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({});
    const action = new ActionInfo('close', 'tab', TAB_ID, 'POST');

    await dataManager.callAction(action);

    expect(post).toHaveBeenCalledWith(action.actionUrl, action.bodyParameters, undefined);
  });

  it('closes a tab with keepalive: the chip is already gone when the request leaves', async () => {
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ tabs: [] });

    await Tab.closeById(TAB_ID);

    expect(post.mock.calls[0]?.[2]).toMatchObject({ fetchOptions: { keepalive: true } });
  });
});
