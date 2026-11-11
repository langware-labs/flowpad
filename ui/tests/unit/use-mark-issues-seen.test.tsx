/** Opening a Monitoring conversation tells the hub its issue messages were received (→ issue "seen"). */
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationKind, SenderKind, dataManager, type FlowMessage } from '@sdk';
import { useMarkIssuesSeen } from '@src/components/conversation/useMarkIssuesSeen';

function msg(id: string, over: Partial<FlowMessage> = {}): FlowMessage {
  return {
    id,
    issue_reply: { issue_typeid: `issue-${id}` },
    delivery_status: 'delivered',
    sender: { kind: SenderKind.User, id: 'hub' },
    ...over,
  } as unknown as FlowMessage;
}

const self = ['me'];

describe('useMarkIssuesSeen', () => {
  let bodies: unknown[];
  beforeEach(() => {
    bodies = [];
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    // eslint-disable-next-line @typescript-eslint/require-await -- the mock stands in for an async action
    vi.spyOn(dataManager, 'callAction').mockImplementation(async (info) => {
      expect(info.name).toBe('mark_received');
      bodies.push(info.bodyParameters);
      return {} as never;
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('marks the unreceived issue messages of a Monitoring conversation received, once', () => {
    const messages = new Map([
      ['a', msg('a')],
      ['b', msg('b', { delivery_status: 'received' })],
      ['c', msg('c', { issue_reply: null })],
      ['d', msg('d', { sender: { kind: SenderKind.User, id: 'me' } as never })],
    ]);
    const { rerender } = renderHook(() => useMarkIssuesSeen(ConversationKind.MONITORING, messages, self));
    rerender();
    expect(bodies).toEqual([{ flow_message_ids: ['a'] }]);
  });

  it('does nothing outside a Monitoring conversation', () => {
    renderHook(() => useMarkIssuesSeen(ConversationKind.DIRECT, new Map([['a', msg('a')]]), self));
    expect(bodies).toEqual([]);
  });
});
