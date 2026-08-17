import {
  ActionInfo,
  dataManager,
  setSupportedPagesForHubMode,
} from '@sdk';
import apiClient from '@sdk/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const TARGET_ID = 'ea395c06-577c-4fbb-b06e-24a24cf6062c';

afterEach(() => {
  vi.restoreAllMocks();
  setSupportedPagesForHubMode(['desk']);
});

describe('DataManager Hub reflection transport', () => {
  it('adds Hub-Reflect when a desktop action must cross the local bridge', async () => {
    setSupportedPagesForHubMode(['desk']);
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue({ ok: true });
    const action = new ActionInfo('record', 'markdown', TARGET_ID, 'GET');
    action.subpath = 'refs';
    action.hubReflect = true;

    await dataManager.callAction(action);

    expect(get).toHaveBeenCalledWith(
      action.actionUrl,
      expect.objectContaining({
        headers: expect.objectContaining({ 'Hub-Reflect': 'true' }),
      }),
    );
  });

  it('does not send the desktop reflection signal when already connected to Hub', async () => {
    setSupportedPagesForHubMode(['hub']);
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue({ ok: true });
    const action = new ActionInfo('record', 'skill', TARGET_ID, 'GET');
    action.subpath = 'refs';
    action.hubReflect = true;

    await dataManager.callAction(action);

    const config = get.mock.calls[0][1];
    expect(config).toBeUndefined();
  });
});
