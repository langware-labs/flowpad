import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FlowMessage } from '@sdk';
import { AttachmentType, BodyStatus } from '@sdk/entities/flow-message';
import { AttachmentChipState } from '@src/components/conversation/AttachmentChip';
import { useAttachments } from '@src/components/conversation/useAttachments';
import { unitTestSetup } from '../../../utils/test-utils';

const MSG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function fmWith(body_status: BodyStatus, opts: { local_path?: string | null } = {}): FlowMessage {
  return new FlowMessage({
    id: MSG_ID,
    body_status,
    attachment_filename: 'conversation-91b6b0bf.flowmsg',
    attachment: [
      {
        attachment_type: AttachmentType.FILE,
        data: 'data/clip.mov',
        local_path: opts.local_path ?? null,
      },
    ],
  });
}

describe('useAttachments index truth table', () => {
  beforeEach(async () => {
    await unitTestSetup();
  });

  it('NA + no local_path → Unavailable, no URL (the dangling-pointer fix)', () => {
    const fm = fmWith(BodyStatus.NA);
    const { result } = renderHook(() => useAttachments(fm, MSG_ID));

    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0].state).toBe(AttachmentChipState.Unavailable);
    expect(result.current.items[0].url).toBeNull();
  });

  it('UPLOADING → Uploading, no URL', () => {
    const fm = fmWith(BodyStatus.UPLOADING);
    const { result } = renderHook(() => useAttachments(fm, MSG_ID));
    expect(result.current.items[0].state).toBe(AttachmentChipState.Uploading);
    expect(result.current.items[0].url).toBeNull();
  });

  it('READY + no local_path → Ready (click-to-pull), no URL', () => {
    const fm = fmWith(BodyStatus.READY);
    const { result } = renderHook(() => useAttachments(fm, MSG_ID));
    expect(result.current.items[0].state).toBe(AttachmentChipState.Ready);
    expect(result.current.items[0].url).toBeNull();
  });

  it('local_path set → Downloaded with a live URL', () => {
    const fm = fmWith(BodyStatus.READY, { local_path: '/var/folders/T/clip.mov' });
    const { result } = renderHook(() => useAttachments(fm, MSG_ID));
    expect(result.current.items[0].state).toBe(AttachmentChipState.Downloaded);
    expect(result.current.items[0].url).toContain('download/data/clip.mov');
  });

  it('download() delegates to FlowMessage.downloadAttachments', async () => {
    const fm = fmWith(BodyStatus.READY);
    const spy = vi.spyOn(fm, 'downloadAttachments').mockResolvedValue(fm);
    const { result } = renderHook(() => useAttachments(fm, MSG_ID));

    await act(async () => {
      await result.current.download();
    });

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('null message → empty items', () => {
    const { result } = renderHook(() => useAttachments(null, MSG_ID));
    expect(result.current.items).toEqual([]);
  });
});
