import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FlowMessage } from '@sdk';
import { AttachmentType, BodyStatus } from '@sdk/entities/flow-message';
import { useAttachments } from '@src/components/conversation/useAttachments';

// FLOWPAD-2153. A host's reply carries `prompt_completion-<id>` as a typed marker + header
// carrier. There is nothing behind it on the guest's side (the row stays on the host), so it
// must never become an entity chip or inflate the Download button's asset count — it used to be
// hidden only because the missing-attachment filter swallowed it.
describe('useAttachments — the reply marker is plumbing, not an attachment', () => {
  it('does not surface a prompt_completion reply marker as an entity or an asset', () => {
    const fm = new FlowMessage({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001',
      body_status: BodyStatus.READY,
      attachment_filename: 'body.flowmsg',
      attachment: [
        { attachment_type: AttachmentType.TYPE_ID, data: 'prompt_completion-cccccccc-cccc-4ccc-8ccc-000000000001' },
      ],
    });
    const { result } = renderHook(() => useAttachments(fm, fm.id));

    expect(result.current.entities).toHaveLength(0);
    expect(result.current.assetCount).toBe(0);
    expect(result.current.assetLabels).toEqual([]);
  });
});
