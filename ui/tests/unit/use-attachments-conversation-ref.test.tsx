import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FlowMessage } from '@sdk';
import { AttachmentType, BodyStatus } from '@sdk/entities/flow-message';
import { useAttachments } from '@src/components/conversation/useAttachments';

const OWN_CONVERSATION = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const TICKET = 'dddddddd-dddd-4ddd-8ddd-000000000001';
const MESSAGE = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001';

// A message auto-carries `conversation-<own id>` + `flow_message-<own id>` (plumbing). A `conversation` that names
// ANOTHER one is a real reference, e.g. the support agent's "Open the ticket" link in the team conversation.
describe('useAttachments: a conversation reference to another conversation is a chip, the self-refs are not', () => {
  const messageWith = (data: string[]) =>
    new FlowMessage({
      id: MESSAGE,
      conversation_id: OWN_CONVERSATION,
      body_status: BodyStatus.NA,
      attachment: data.map((d) => ({ attachment_type: AttachmentType.TYPE_ID, data: d })),
    });

  it("hides the message's own conversation and message refs", () => {
    const fm = messageWith([`conversation-${OWN_CONVERSATION}`, `flow_message-${MESSAGE}`]);
    const { result } = renderHook(() => useAttachments(fm, fm.id));

    expect(result.current.entities).toHaveLength(0);
  });

  it('shows another conversation the message points to', () => {
    const fm = messageWith([`conversation-${OWN_CONVERSATION}`, `flow_message-${MESSAGE}`, `conversation-${TICKET}`]);
    const { result } = renderHook(() => useAttachments(fm, fm.id));

    expect(result.current.entities.map((t) => `${t.type}-${t.id}`)).toEqual([`conversation-${TICKET}`]);
  });
});
