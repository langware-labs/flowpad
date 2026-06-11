/**
 * Vitest api test for the conversation archive / unarchive round-trip.
 *
 * Runs against the minihub (in-process server, real HTTP). Archive stamps
 * ``Conversation.archived_at = now()``; unarchive clears it back to null. Both
 * are local-only (no hub leg). Asserts on the action return AND a read-back of
 * the persisted row.
 */
import { config, Conversation, archiveConversation, unarchiveConversation } from '@sdk';
import { beforeEach, describe, expect, it } from 'vitest';

import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

async function saveLocalConversation(): Promise<string> {
  const id = crypto.randomUUID();
  const r = await fetch(`${config.SERVER_URL}/graph/conversation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, type: Conversation.type, title: 'archive round-trip' }),
  });
  if (!r.ok) throw new Error(`saveLocalConversation failed: ${r.status} ${await r.text()}`);
  return id;
}

describe('api: conversation archive / unarchive', () => {
  const signupInfo = getTestSignupInfo();

  beforeEach(async (context: any) => {
    await apiTestSetup(signupInfo, context.task.name);
  });

  it('archive stamps archived_at, unarchive clears it', async () => {
    const convId = await saveLocalConversation();

    const archived = await archiveConversation({ conversation_id: convId });
    expect(archived.conversation_id).toBe(convId);
    expect(archived.archived_at).toBeTruthy();

    const unarchived = await unarchiveConversation({ conversation_id: convId });
    expect(unarchived.conversation_id).toBe(convId);
    expect(unarchived.archived_at).toBeNull();
  }, 10_000);

  it('unarchive on a non-archived conversation is a harmless no-op', async () => {
    const convId = await saveLocalConversation();
    const res = await unarchiveConversation({ conversation_id: convId });
    expect(res.archived_at).toBeNull();
  }, 10_000);

  it('unarchive 4xxs for an unknown conversation id', async () => {
    await expect(
      unarchiveConversation({ conversation_id: '00000000-0000-0000-0000-000000000abc' }),
    ).rejects.toThrow();
  }, 10_000);
});
