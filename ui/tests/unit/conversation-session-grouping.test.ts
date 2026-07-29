/**
 * groupConversationItems — the live-session partition over the conversation
 * feed. Pins: consecutive same-session runs collapse into ONE SESSION_GROUP
 * (children in order, prompt/reply counts from attachments); interleaved human
 * messages break the run (inline runs, not a sticky card); messages without a
 * session id — or whose body hasn't resolved from the live query yet — stay
 * flat (backward compat / cold-window degradation); SESSION_EVENT lines ride
 * inside the group as ordinary children.
 */
import { FlowMessage, FlowMessageKind } from '@sdk';
import { describe, expect, it } from 'vitest';

import {
  buildConversationItems,
  ConversationItemKind,
  groupConversationItems,
  type SessionGroupItem,
} from '@src/components/conversation/conversation-items';

const SID_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const SID_B = 'bbbbbbbb-0000-4000-8000-000000000002';

let seq = 0;
function fm(over: Partial<FlowMessage> = {}): FlowMessage {
  seq += 1;
  return new FlowMessage({
    id: `msg-${seq}`,
    text: `m${seq}`,
    ...over,
  } as Partial<FlowMessage>);
}

function pointerItems(messages: FlowMessage[]) {
  const pointers = messages.map((m, i) => ({
    id: m.id!,
    ts: new Date(2026, 0, 1, 0, i).toISOString(),
  }));
  const byId = new Map(messages.map((m) => [m.id!, m]));
  const items = buildConversationItems(pointers, []);
  return { items, getFm: (id: string) => byId.get(id) ?? null };
}

const promptAtt = { attachment_type: 'prompt', data: 'run it' };
const resultAtt = { attachment_type: 'type_id', data: 'prompt_completion-r1' };

describe('groupConversationItems', () => {
  it('collapses a consecutive same-session run into one group with counts', () => {
    const messages = [
      fm(),
      fm({ remote_worker_session_id: SID_A, attachment: [promptAtt] } as Partial<FlowMessage>),
      fm({ remote_worker_session_id: SID_A, attachment: [resultAtt] } as Partial<FlowMessage>),
      fm({ remote_worker_session_id: SID_A, attachment: [promptAtt] } as Partial<FlowMessage>),
      fm(),
    ];
    const { items, getFm } = pointerItems(messages);
    const grouped = groupConversationItems(items, getFm);

    expect(grouped.map((g) => g.kind)).toEqual([
      ConversationItemKind.POINTER,
      ConversationItemKind.SESSION_GROUP,
      ConversationItemKind.POINTER,
    ]);
    const group = grouped[1] as SessionGroupItem;
    expect(group.sessionId).toBe(SID_A);
    expect(group.children).toHaveLength(3);
    expect(group.promptCount).toBe(2);
    expect(group.replyCount).toBe(1);
  });

  it('breaks the run on interleaved human messages and on a session switch', () => {
    const messages = [
      fm({ remote_worker_session_id: SID_A, attachment: [promptAtt] } as Partial<FlowMessage>),
      fm(), // human chatter splits the run
      fm({ remote_worker_session_id: SID_A, attachment: [promptAtt] } as Partial<FlowMessage>),
      fm({ remote_worker_session_id: SID_B, attachment: [promptAtt] } as Partial<FlowMessage>),
    ];
    const { items, getFm } = pointerItems(messages);
    const grouped = groupConversationItems(items, getFm);

    expect(grouped.map((g) => g.kind)).toEqual([
      ConversationItemKind.SESSION_GROUP,
      ConversationItemKind.POINTER,
      ConversationItemKind.SESSION_GROUP,
      ConversationItemKind.SESSION_GROUP,
    ]);
    expect((grouped[2] as SessionGroupItem).sessionId).toBe(SID_A);
    expect((grouped[3] as SessionGroupItem).sessionId).toBe(SID_B);
  });

  it('renders flat when the body is unresolved or carries no session id', () => {
    const messages = [
      fm({ remote_worker_session_id: SID_A } as Partial<FlowMessage>),
      fm(),
    ];
    const { items } = pointerItems(messages);
    // Cold live-query window: every body unresolved → everything stays flat.
    const grouped = groupConversationItems(items, () => null);
    expect(grouped.map((g) => g.kind)).toEqual([
      ConversationItemKind.POINTER,
      ConversationItemKind.POINTER,
    ]);
  });

  it('keeps SESSION_EVENT lines inside the group without counting them', () => {
    const messages = [
      fm({ remote_worker_session_id: SID_A, attachment: [promptAtt] } as Partial<FlowMessage>),
      fm({
        remote_worker_session_id: SID_A,
        kind: FlowMessageKind.SESSION_EVENT,
        attachment: [{ attachment_type: 'type_id', data: `remote_worker_session-${SID_A}` }],
      } as Partial<FlowMessage>),
      fm({ remote_worker_session_id: SID_A, attachment: [resultAtt] } as Partial<FlowMessage>),
    ];
    const { items, getFm } = pointerItems(messages);
    const grouped = groupConversationItems(items, getFm);

    expect(grouped).toHaveLength(1);
    const group = grouped[0] as SessionGroupItem;
    expect(group.children).toHaveLength(3);
    expect(group.promptCount).toBe(1);
    expect(group.replyCount).toBe(1);
  });

  it('groups drafts by their own fm (no pointer resolution needed)', () => {
    const draft = fm({ remote_worker_session_id: SID_A, is_draft: true } as Partial<FlowMessage>);
    const items = buildConversationItems([], [draft]);
    const grouped = groupConversationItems(items, () => null);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].kind).toBe(ConversationItemKind.SESSION_GROUP);
  });
});
