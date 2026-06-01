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

const SKILL_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MD_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function fmWithEntities(
  body_status: BodyStatus,
  body_downloaded: boolean,
): FlowMessage {
  return new FlowMessage({
    id: MSG_ID,
    body_status,
    body_downloaded,
    attachment: [
      { attachment_type: AttachmentType.TYPE_ID, data: `skill-${SKILL_ID}` },
      { attachment_type: AttachmentType.TYPE_ID, data: `markdown-${MD_ID}` },
      // structural self-refs the send path injects — must be dropped
      { attachment_type: AttachmentType.TYPE_ID, data: `conversation-${MSG_ID}` },
      { attachment_type: AttachmentType.TYPE_ID, data: `flow_message-${MSG_ID}` },
      // a real file rides in the same bundle
      { attachment_type: AttachmentType.FILE, data: 'data/notes.txt', local_path: null },
    ],
  });
}

describe('useAttachments entity surface', () => {
  beforeEach(async () => {
    await unitTestSetup();
  });

  it('entities excludes structural types and keeps real assets', () => {
    const fm = fmWithEntities(BodyStatus.READY, false);
    const { result } = renderHook(() => useAttachments(fm, MSG_ID));
    const types = result.current.entities.map((t) => t.type);
    expect(types).toEqual(['skill', 'markdown']);
    expect(types).not.toContain('conversation');
    expect(types).not.toContain('flow_message');
  });

  it('downloaded mirrors fm.body_downloaded', () => {
    const notYet = renderHook(() => useAttachments(fmWithEntities(BodyStatus.READY, false), MSG_ID));
    expect(notYet.result.current.downloaded).toBe(false);

    const done = renderHook(() => useAttachments(fmWithEntities(BodyStatus.READY, true), MSG_ID));
    expect(done.result.current.downloaded).toBe(true);
  });

  it('assetCount + assetLabels cover entities (typeids) and files (names)', () => {
    const fm = fmWithEntities(BodyStatus.READY, false);
    const { result } = renderHook(() => useAttachments(fm, MSG_ID));
    // 2 entities + 1 file = 3
    expect(result.current.assetCount).toBe(3);
    expect(result.current.assetLabels).toEqual([
      `skill-${SKILL_ID}`,
      `markdown-${MD_ID}`,
      'notes.txt',
    ]);
  });

  it('null message → no entities, not downloaded, zero count', () => {
    const { result } = renderHook(() => useAttachments(null, MSG_ID));
    expect(result.current.entities).toEqual([]);
    expect(result.current.downloaded).toBe(false);
    expect(result.current.assetCount).toBe(0);
  });
});
