/**
 * The wire contract for sharing a budget by email.
 *
 * Money makes the failure modes matter more than usual: a share that silently does nothing looks
 * identical to one that worked, and a share reported as failed when the role actually landed pushes
 * the sender into a retry that then says "already has access". Both are pinned here.
 */
import { describe, expect, it, vi } from 'vitest';

import { shareEndpointByEmail, shareEndpointFailureText } from '@src/components/llm-endpoints/share-endpoint';

/** An axios-shaped rejection: what the client actually throws — envelope, not `message`. */
function hubError(status: number, detail?: string) {
  return { response: { status, data: detail ? { detail } : {} }, message: `Request failed with status code ${status}` };
}

describe('shareEndpointByEmail', () => {
  it('invites each address through the sdk one-liner', async () => {
    const share = vi.fn().mockResolvedValue(undefined);

    const outcome = await shareEndpointByEmail({ share } as never, ['bob@x.com', 'carol@x.com']);

    expect(share).toHaveBeenCalledTimes(2);
    expect(share).toHaveBeenNthCalledWith(1, ['bob@x.com']);
    expect(share).toHaveBeenNthCalledWith(2, ['carol@x.com']);
    expect(outcome).toEqual({ granted: ['bob@x.com', 'carol@x.com'], failed: [] });
  });

  it('keeps going after one address fails, and says which', async () => {
    // The hub takes one recipient per POST, so a batch is N requests. Aborting on the first
    // rejection would discard grants that already landed and leave the sender unable to tell which.
    const share = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(hubError(403, 'Only the owner may invite'))
      .mockResolvedValueOnce(undefined);

    const outcome = await shareEndpointByEmail({ share } as never, ['a@x.com', 'b@x.com', 'c@x.com']);

    expect(outcome.granted).toEqual(['a@x.com', 'c@x.com']);
    expect(outcome.failed).toEqual([{ email: 'b@x.com', reason: 'Only the owner may invite' }]);
  });

  it('counts an existing member as granted', async () => {
    // The hub refuses to re-invite and answers 400 naming `change_role`. The access being asked for
    // is already in place, so calling that a failure would be wrong.
    const share = vi.fn().mockRejectedValue(hubError(400, 'use change_role to modify an existing membership'));

    const outcome = await shareEndpointByEmail({ share } as never, ['bob@x.com']);

    expect(outcome).toEqual({ granted: ['bob@x.com'], failed: [] });
  });

  it('sends nothing when there is nobody to send to', async () => {
    const share = vi.fn();

    expect(await shareEndpointByEmail({ share } as never, [])).toEqual({ granted: [], failed: [] });
    expect(share).not.toHaveBeenCalled();
  });
});

describe('shareEndpointFailureText', () => {
  it('explains the owner-only rule on 403', () => {
    // Surprising enough to deserve its own sentence: an admin may re-budget the endpoint, replace
    // its key and allocate from it, and still cannot give it away.
    expect(shareEndpointFailureText(hubError(403), 'fallback')).toBe('Only the budget’s owner can share it');
  });

  it('prefers the hub’s own wording when it has some', () => {
    expect(shareEndpointFailureText(hubError(403, 'Budget is archived'), 'fallback')).toBe('Budget is archived');
  });

  it('does not call a mail failure a failed share', () => {
    // The role is granted before the mail step, so access DID land. "Could not share" would be
    // false and would invite a retry.
    expect(shareEndpointFailureText(hubError(502), 'fallback')).toBe(
      'Access granted, but the invitation email failed to send',
    );
  });

  it('asks for a sign-in on 401', () => {
    expect(shareEndpointFailureText(hubError(401), 'fallback')).toBe('Sign in to share this budget');
  });

  it('reads the envelope rather than the useless axios message', () => {
    expect(shareEndpointFailureText(hubError(400, 'Bad address'), 'fallback')).toBe('Bad address');
    expect(shareEndpointFailureText(hubError(418), 'fallback')).toBe('fallback');
  });
});
