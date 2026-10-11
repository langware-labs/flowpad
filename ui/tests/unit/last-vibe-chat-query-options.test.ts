/**
 * Discuss on an asset resumes the asset's latest chat even before its first
 * turn — so it asks without the "was opened" filter. The selection itself runs
 * against a real backend in tests/api/last-vibe-chat-query.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { lastVibeChatQuery } from '@src/pages/flow-page/vibe-process-resolver';

const PROJECT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
type Leaf = { op: string; operands: unknown[] };
const fields = (q: ReturnType<typeof lastVibeChatQuery>) =>
  ((q.query?.match?.operands ?? []) as Leaf[]).map((o) => `${o.op}:${String(o.operands[0])}`);

describe('lastVibeChatQuery', () => {
  it('by default keeps only chats that were opened', () => {
    expect(fields(lastVibeChatQuery(PROJECT, 'markdown-x'))).toContain('$IS_NOT_NULL:last_active_at');
  });

  it('openedOnly:false (Discuss) also finds a chat that has not run a turn yet', () => {
    const q = lastVibeChatQuery(PROJECT, 'markdown-x', { openedOnly: false });
    expect(fields(q)).not.toContain('$IS_NOT_NULL:last_active_at');
    expect(fields(q)).toContain('$EQ:target_typeid_str');
  });
});
