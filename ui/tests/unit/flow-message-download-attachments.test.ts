import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dataManager } from '@sdk';
import { BodyStatus, FlowMessage } from '@sdk/entities/flow-message';
import { unitTestSetup } from '../utils/test-utils';

/**
 * FlowMessage.downloadAttachments() is frontend gate #1: it must NOT issue a
 * download_body action unless the body is READY. A NA (dangling) or UPLOADING
 * body is a no-op — that is what stops the UI from firing a request the backend
 * would have to 404.
 */
describe('FlowMessage.downloadAttachments gate', () => {
  beforeEach(async () => {
    await unitTestSetup();
  });

  it.each([BodyStatus.NA, BodyStatus.UPLOADING])(
    'is a no-op when body_status=%s (no action dispatched)',
    async (status) => {
      const spy = vi.spyOn(dataManager, 'callAction').mockResolvedValue(undefined as never);
      const fm = new FlowMessage({
        id: '11111111-1111-4111-8111-111111111111',
        body_status: status,
        attachment_filename: 'conversation-91b6b0bf.flowmsg',
      });

      await fm.downloadAttachments();

      expect(spy).not.toHaveBeenCalled();
    },
  );

  it('dispatches download_body when body_status=READY', async () => {
    const spy = vi.spyOn(dataManager, 'callAction').mockResolvedValue(undefined as never);
    const fm = new FlowMessage({
      id: '22222222-2222-4222-8222-222222222222',
      body_status: BodyStatus.READY,
      attachment_filename: 'body.flowmsg',
    });

    await fm.downloadAttachments();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0].name).toBe('download_body');
  });
});
