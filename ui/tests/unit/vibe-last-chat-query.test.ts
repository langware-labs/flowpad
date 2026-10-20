import { describe, expect, it } from 'vitest';
import { lastVibeChatQuery } from '@src/pages/flow-page/vibe-process-resolver';

const DOC = 'compute_node-@local/Users/a/records_data/flow_message/m/embedded/data/Plan.md';
const ops = (projectId: string | null) =>
  (lastVibeChatQuery(projectId, DOC, { openedOnly: false }).query as unknown as {
    match: { operands: { op: string; operands: unknown[] }[] };
  }).match.operands;

describe('lastVibeChatQuery — resume the chat about a doc', () => {
  it('scopes to the project when the doc has one', () => {
    expect(ops('p-1')[0]).toEqual({ op: '$EQ', operands: ['project_id', 'p-1'] });
  });

  it('matches project-less chats (chat-scratch) when there is no project', () => {
    expect(ops(null)[0]).toEqual({ op: '$IS_NULL', operands: ['project_id'] });
    expect(ops(null)).toContainEqual({ op: '$EQ', operands: ['target_typeid_str', DOC] });
  });
});
