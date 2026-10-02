import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionInfo, dataManager } from '@sdk';
import { sendReply } from '@sdk/entities/notifications';
import { ConnectionManager } from '@sdk/websocket';
import { unitTestSetup } from '../utils/test-utils';

/**
 * `callActionPreferWS` answers the same value on either transport. The server ships the whole
 * `ApiResponse` envelope over the socket while REST (`apiClient`) unwraps it to `data`, so a caller
 * reading the answer — `sendReply`'s new message id, which "Task it on send" needs — got the id
 * over REST and `undefined` over a live socket.
 */
describe('callActionPreferWS — one answer on both transports', () => {
  const CONV = '44444444-4444-4444-8444-444444444444';

  beforeEach(async () => {
    await unitTestSetup();
    const cm = ConnectionManager.getInstance();
    vi.spyOn(cm, 'connected', 'get').mockReturnValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  it('unwraps the envelope a WS reply carries', async () => {
    vi.spyOn(ConnectionManager.getInstance(), 'sendRestApiMessage').mockResolvedValue({
      status: 'SUCCESS',
      message: 'success',
      data: { id: 'msg-1' },
    } as never);
    const info = new ActionInfo('add_message', 'conversation', CONV, 'POST');
    info.bodyParameters = { message: 'hi' };
    expect(await dataManager.callActionPreferWS(info)).toEqual({ id: 'msg-1' });
    expect(await sendReply({ conversationId: CONV }, 'hi')).toEqual({ id: 'msg-1' });
  });

  it('a FAIL envelope rejects, as REST does', async () => {
    vi.spyOn(ConnectionManager.getInstance(), 'sendRestApiMessage').mockResolvedValue({
      status: 'FAIL',
      message: 'nope',
      data: null,
    } as never);
    const info = new ActionInfo('add_message', 'conversation', CONV, 'POST');
    info.bodyParameters = { message: 'hi' };
    await expect(dataManager.callActionPreferWS(info)).rejects.toThrow('nope');
  });
});
