/**
 * The wire contract for sharing a budget by email.
 *
 * Money makes the failure modes matter more than usual: a share that silently does nothing looks
 * identical to one that worked, and a share reported as failed when the role actually landed pushes
 * the sender into a retry that then says "already has access". Both are pinned here.
 *
 * The CALL SHAPE is pinned too, and that is not ceremony. This module used to send
 * `endpoint.share([email])`, which reaches a `share` action only `flow_sdk` registers: it worked in
 * Electron and answered 400 "Post not supported for this path" on the `/dock/hub/llm-endpoints`
 * page, which is served straight off the hub. Nothing here caught it, because the only assertions
 * were about outcomes. `members` routes on both backends — so the action, the role and the landing
 * path are asserted explicitly.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  ENDPOINT_SHARE_ROLE,
  shareEndpointByEmail,
  shareEndpointFailureText,
} from '@src/components/llm-endpoints/share-endpoint';

/** A stand-in for the entity: only `inviteMember` and `id` are reached. */
function fakeEndpoint(inviteMember: ReturnType<typeof vi.fn>, id = 'e1') {
  return { inviteMember, id } as never;
}

/** An axios-shaped rejection: what the client actually throws — envelope, not `message`. */
function hubError(status: number, detail?: string) {
  return { response: { status, data: detail ? { detail } : {} }, message: `Request failed with status code ${status}` };
}

describe('shareEndpointByEmail', () => {
  it('invites each address through `members`, at reader, one POST per recipient', async () => {
    const inviteMember = vi.fn().mockResolvedValue(undefined);

    const outcome = await shareEndpointByEmail(fakeEndpoint(inviteMember), ['bob@x.com', 'carol@x.com']);

    expect(inviteMember).toHaveBeenCalledTimes(2);
    expect(inviteMember).toHaveBeenNthCalledWith(1, 'bob@x.com', ENDPOINT_SHARE_ROLE, {
      callbackOverride: '/dock/hub/llm-endpoints/e1',
      notifyByEmail: false,
    });
    expect(inviteMember).toHaveBeenNthCalledWith(2, 'carol@x.com', ENDPOINT_SHARE_ROLE, {
      callbackOverride: '/dock/hub/llm-endpoints/e1',
      notifyByEmail: false,
    });
    expect(outcome).toEqual({ granted: ['bob@x.com', 'carol@x.com'], failed: [] });
  });

  it('shares without emailing — the recipient already has the budget', async () => {
    // Auto-accept writes the `reader` edge before the hub would send, so the mail announces a fait
    // accompli. A budget is handed over in conversation, not discovered in an inbox.
    const inviteMember = vi.fn().mockResolvedValue(undefined);

    await shareEndpointByEmail(fakeEndpoint(inviteMember), ['bob@x.com']);

    expect(inviteMember).toHaveBeenCalledWith('bob@x.com', ENDPOINT_SHARE_ROLE, {
      callbackOverride: '/dock/hub/llm-endpoints/e1',
      notifyByEmail: false,
    });
  });

  it('shares at reader — spend and watch, never configure', () => {
    // Anything above `reader` would make the endpoint's cap advisory: the recipient could raise it.
    // Mirrors SHARE_ROLE in `flow_sdk/builtin/llm_endpoint.py` and the hub's own share suite.
    expect(ENDPOINT_SHARE_ROLE).toBe('reader');
  });

  it('keeps going after one address fails, and says which', async () => {
    // The hub takes one recipient per POST, so a batch is N requests. Aborting on the first
    // rejection would discard grants that already landed and leave the sender unable to tell which.
    const inviteMember = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(hubError(403, 'Only the owner may invite'))
      .mockResolvedValueOnce(undefined);

    const outcome = await shareEndpointByEmail(fakeEndpoint(inviteMember), ['a@x.com', 'b@x.com', 'c@x.com']);

    expect(outcome.granted).toEqual(['a@x.com', 'c@x.com']);
    expect(outcome.failed).toEqual([{ email: 'b@x.com', reason: 'Only the owner may invite', accessLanded: false }]);
  });

  it('marks a mail failure as one where the access still landed', async () => {
    // `addOne` undoes its allocation when a share fails; on 5xx the role edge was already written,
    // so this flag is what stops the undo from taking back a share that worked.
    const inviteMember = vi.fn().mockRejectedValue(hubError(502));

    const outcome = await shareEndpointByEmail(fakeEndpoint(inviteMember), ['b@x.com']);

    expect(outcome.failed).toEqual([
      { email: 'b@x.com', reason: 'Access granted, but the invitation email failed to send', accessLanded: true },
    ]);
  });

  it('counts an existing member as granted', async () => {
    // The hub refuses to re-invite and answers 400 naming `change_role`. The access being asked for
    // is already in place, so calling that a failure would be wrong.
    const inviteMember = vi.fn().mockRejectedValue(hubError(400, 'use change_role to modify an existing membership'));

    const outcome = await shareEndpointByEmail(fakeEndpoint(inviteMember), ['bob@x.com']);

    expect(outcome).toEqual({ granted: ['bob@x.com'], failed: [] });
  });

  it('sends nothing when there is nobody to send to', async () => {
    const inviteMember = vi.fn();

    expect(await shareEndpointByEmail(fakeEndpoint(inviteMember), [])).toEqual({ granted: [], failed: [] });
    expect(inviteMember).not.toHaveBeenCalled();
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
