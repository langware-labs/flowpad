/**
 * The wire contract for sharing an agent by email: `inviteMember` → `POST agent/<id>/members`,
 * hub-reflected, at `reader`, landing on the hub's agent page.
 */
import { describe, expect, it, vi } from 'vitest';

const { Agent, dataManager } = await import('@sdk');
const { AGENT_SHARE_ROLE, shareAgentByEmail, shareAgentFailureText } =
  await import('@src/components/assets/editor/agent-profile/share-agent');

const AGENT_ID = '11111111-2222-4333-8444-555555555555';

function fakeAgent(inviteMember: ReturnType<typeof vi.fn>) {
  return { inviteMember, id: AGENT_ID } as never;
}

function hubError(status: number, detail?: string) {
  return { response: { status, data: detail ? { detail } : {} }, message: `Request failed with status code ${status}` };
}

describe('shareAgentByEmail', () => {
  it('invites each address at reader, landing on the hub agent page', async () => {
    const inviteMember = vi.fn().mockResolvedValue(undefined);

    const outcome = await shareAgentByEmail(fakeAgent(inviteMember), ['bob@x.com', 'carol@x.com']);

    expect(AGENT_SHARE_ROLE).toBe('reader');
    expect(inviteMember).toHaveBeenCalledTimes(2);
    for (const email of ['bob@x.com', 'carol@x.com']) {
      expect(inviteMember).toHaveBeenCalledWith(email, 'reader', { callbackOverride: `/agent/${AGENT_ID}` });
    }
    expect(outcome).toEqual({ granted: ['bob@x.com', 'carol@x.com'], failed: [] });
  });

  it('counts an existing member as granted and reports real failures per address', async () => {
    const inviteMember = vi
      .fn()
      .mockRejectedValueOnce(hubError(400, 'use change_role for an existing member'))
      .mockRejectedValueOnce(hubError(403, 'Not allowed'));

    const outcome = await shareAgentByEmail(fakeAgent(inviteMember), ['bob@x.com', 'carol@x.com']);

    expect(outcome.granted).toEqual(['bob@x.com']);
    expect(outcome.failed).toEqual([{ email: 'carol@x.com', reason: 'Not allowed' }]);
  });

  it('reads the error envelope, and treats a 5xx as a failed email rather than a failed share', () => {
    expect(shareAgentFailureText(hubError(401), 'x')).toBe('Sign in to share this agent');
    expect(shareAgentFailureText(hubError(403), 'x')).toBe('Only the agent’s owner can share it');
    expect(shareAgentFailureText(hubError(502), 'x')).toBe('Access granted, but the invitation email failed to send');
    expect(shareAgentFailureText(hubError(422), 'fallback')).toBe('fallback');
  });
});

describe('Agent.inviteMember', () => {
  it('POSTs members, hub-reflected, with the email and the agent as the target', async () => {
    const call = vi.spyOn(dataManager, 'callAction').mockResolvedValue([]);

    await new Agent({ id: AGENT_ID, name: 'q' }).inviteMember('Bob@X.com', 'reader', {
      callbackOverride: `/agent/${AGENT_ID}`,
    });

    const info = call.mock.calls[0][0];
    expect(info.method).toBe('POST');
    expect(info.hubReflect).toBe(true);
    expect(info.fullActionUrl).toContain(`agent/${AGENT_ID}/members`);
    expect(info.bodyParameters).toEqual({
      recipient_email: 'bob@x.com',
      invitation_targets: [{ typeid: `agent-${AGENT_ID}`, role: 'reader' }],
      callback_override: `/agent/${AGENT_ID}`,
    });
    call.mockRestore();
  });
});
