import { describe, it, expect } from 'vitest';
import {
  Conversation,
  createConversationForShare,
  type ConversationParticipant,
  type CreateAndSendParams,
} from '@sdk';

/**
 * RCA capture: a share to a REMOTE (email) recipient must stamp the owning
 * project onto the new conversation, so the sender's own copy renders the
 * attachment inline instead of behind a "Download" card.
 *
 * `createConversationForShare` takes the remote branch when any participant
 * carries an @-email. That branch builds `new Conversation({...})`, assigns it
 * to `draftRef.current`, and only THEN calls `conv.save()` / `conv.share()`
 * (backend + hub). There is no backend in this unit env, so those reject — but
 * `draftRef.current` already holds the exact Conversation that would be
 * persisted. We inspect it directly (no mock, no injected state): the built
 * conversation should carry the `project_id` we passed in.
 */
describe('remote share stamps project_id on the new conversation', () => {
  it('carries params.project_id onto the built remote conversation', async () => {
    const draftRef = { current: null as Conversation | null };
    const params: CreateAndSendParams = {
      project_id: 'proj-123',
      participants: [
        { email: 'recipient@example.com', role: 'member', status: 'pending' } as ConversationParticipant,
      ],
      title: 'Shared doc',
    };

    // save()/share() need a backend+hub; irrelevant to the defect. draftRef is
    // set before either runs, so the rejection doesn't rob us of the built conv.
    await createConversationForShare(params, { draftRef }).catch(() => {});

    expect(draftRef.current).toBeTruthy();
    // BUG: the remote branch omits project_id from `new Conversation({...})`,
    // so this is undefined today. The fix (carry params.project_id) makes it
    // equal 'proj-123'.
    expect(draftRef.current!.project_id).toBe('proj-123');
  });
});
