/**
 * The wire contract for emailing a team's people an invitation.
 *
 * The TARGET is the whole point and is pinned first. Adding someone to a team budget grants them
 * the ENDPOINT and deliberately sends no mail, so a "Send invite" button is the only way they are
 * ever told — and it must not be built on that endpoint: the hub refuses a re-invite to something
 * already held (400, naming `change_role`) and `shareEndpointByEmail` counts that refusal as
 * GRANTED. The button would have shown a green tick and sent nothing, for exactly the people an
 * admin most wants to reach. So these assert the team typeid, the role and the landing path
 * explicitly, not just the outcome buckets.
 *
 * The three kinds of recipient an admin actually has in front of them are each pinned:
 * somebody with no account (the hub provisions and mails them), somebody with an account who is
 * not on the team, and somebody already on it — which is its own outcome, never a success and
 * never a failure.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const UUID = (n: number) => `550e8400-e29b-41d4-a716-4466554400${String(n).padStart(2, '0')}`;
const TEAM = UUID(4);

const h = vi.hoisted(() => ({
  getByTypeId: vi.fn(),
  inviteMember: vi.fn(),
}));

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    dataManager: { ...(actual.dataManager as object), getByTypeId: h.getByTypeId },
  };
});

import {
  TEAM_INVITE_ROLE,
  inviteToTeamByEmail,
  isAlreadyOnTeam,
  teamInviteFailureText,
  teamInviteLandingPath,
} from '@src/components/organization/budgets/invite-to-team';

/** An axios-shaped rejection: what the client actually throws — envelope, not `message`. */
function hubError(status: number, detail?: string) {
  return { response: { status, data: detail ? { detail } : {} }, message: `Request failed with status code ${status}` };
}

/** The hub's own words when the recipient already accepted an invitation to this entity
 *  (`membership/services.py`). Copied verbatim because `isAlreadyOnTeam` matches on it. */
const ALREADY = hubError(400, 'User has already accepted; use change_role to change their role.');

afterEach(() => {
  vi.clearAllMocks();
});

describe('inviteToTeamByEmail', () => {
  it('invites to the TEAM at member, one POST per recipient, landing on People & teams', async () => {
    // Not the endpoint. The whole feature exists because the endpoint refuses these people.
    h.getByTypeId.mockResolvedValue({ inviteMember: h.inviteMember });
    h.inviteMember.mockResolvedValue(undefined);

    const outcome = await inviteToTeamByEmail(TEAM, ['bob@x.com', 'carol@x.com']);

    expect(h.getByTypeId).toHaveBeenCalledTimes(1);
    expect(String(h.getByTypeId.mock.calls[0][0])).toBe(`team-${TEAM}`);
    expect(h.inviteMember).toHaveBeenCalledTimes(2);
    expect(h.inviteMember).toHaveBeenNthCalledWith(1, 'bob@x.com', TEAM_INVITE_ROLE, {
      callbackOverride: '/dock/hub/organization',
    });
    expect(h.inviteMember).toHaveBeenNthCalledWith(2, 'carol@x.com', TEAM_INVITE_ROLE, {
      callbackOverride: '/dock/hub/organization',
    });
    expect(outcome).toEqual({ invited: ['bob@x.com', 'carol@x.com'], already: [], failed: [] });
  });

  it('invites at member — never at or above what an admin holds', () => {
    // `member` is the hub's own default for `inviteMember`; anything higher would be refused by
    // `can_assign` for an admin caller, which is most of the people pressing this button.
    expect(TEAM_INVITE_ROLE).toBe('member');
  });

  it('names a landing path, because the hub falls back to a URL the app has no route for', () => {
    expect(teamInviteLandingPath()).toBe('/dock/hub/organization');
  });

  it('invites someone with no account at all — the hub provisions and mails them', async () => {
    // Nothing about the call changes: the hub materialises an `invited` shadow user and the mail
    // carries a link that signs them up on accept. This is the case the button exists for, so it
    // must not be special-cased into a different code path here.
    h.getByTypeId.mockResolvedValue({ inviteMember: h.inviteMember });
    h.inviteMember.mockResolvedValue(undefined);

    const outcome = await inviteToTeamByEmail(TEAM, ['never-signed-up@x.com']);

    expect(h.inviteMember).toHaveBeenCalledWith('never-signed-up@x.com', TEAM_INVITE_ROLE, {
      callbackOverride: '/dock/hub/organization',
    });
    expect(outcome).toEqual({ invited: ['never-signed-up@x.com'], already: [], failed: [] });
  });

  it('reports someone already on the team as `already` — not a success, not a failure', async () => {
    // Success would claim an email that never left. Failure would send the admin hunting for a bug
    // that is not there. `shareEndpointByEmail` makes the first mistake by design, which is why
    // this module exists rather than a flag on that one.
    h.getByTypeId.mockResolvedValue({ inviteMember: h.inviteMember });
    h.inviteMember.mockRejectedValue(ALREADY);

    const outcome = await inviteToTeamByEmail(TEAM, ['ada@x.com']);

    expect(outcome).toEqual({ invited: [], already: ['ada@x.com'], failed: [] });
  });

  it('re-invites someone who is on the team WITHOUT an accepted invitation', async () => {
    // Put there by a group grant, or the team's creator: the hub finds no accepted Invitation, so
    // it mints one and sends the mail. That is the resend, and it must read as a plain success.
    h.getByTypeId.mockResolvedValue({ inviteMember: h.inviteMember });
    h.inviteMember.mockResolvedValue(undefined);

    const outcome = await inviteToTeamByEmail(TEAM, ['founder@x.com']);

    expect(outcome.invited).toEqual(['founder@x.com']);
    expect(outcome.already).toEqual([]);
  });

  it('sorts a mixed roster into the three buckets in one pass', async () => {
    // The realistic press of "Send invites to everyone": a new hire, someone already on the team,
    // and one the caller may not invite. Nothing aborts on the first rejection — the hub takes one
    // recipient per POST and an admin mailing thirty people needs to know which one bounced.
    h.getByTypeId.mockResolvedValue({ inviteMember: h.inviteMember });
    h.inviteMember
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(ALREADY)
      .mockRejectedValueOnce(hubError(403, "Cannot invite at role 'member': caller has no role on this entity"));

    const outcome = await inviteToTeamByEmail(TEAM, ['new@x.com', 'ada@x.com', 'nope@x.com']);

    expect(h.inviteMember).toHaveBeenCalledTimes(3);
    expect(outcome.invited).toEqual(['new@x.com']);
    expect(outcome.already).toEqual(['ada@x.com']);
    expect(outcome.failed).toEqual([
      { email: 'nope@x.com', reason: "Cannot invite at role 'member': caller has no role on this entity" },
    ]);
  });

  it('fails every address once, and for the real reason, when the team itself cannot be loaded', async () => {
    // `dataManager` is cache-first, so this is the read that actually issues the request. One
    // unreachable team is every address failing for one reason; said per address so the caller can
    // mark rows rather than showing a toast with nothing attached.
    h.getByTypeId.mockRejectedValue(hubError(404, 'Entity not found'));

    const outcome = await inviteToTeamByEmail(TEAM, ['a@x.com', 'b@x.com']);

    expect(h.inviteMember).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      invited: [],
      already: [],
      failed: [
        { email: 'a@x.com', reason: 'Entity not found' },
        { email: 'b@x.com', reason: 'Entity not found' },
      ],
    });
  });

  it('does not touch the network for an empty list', async () => {
    const outcome = await inviteToTeamByEmail(TEAM, []);

    expect(h.getByTypeId).not.toHaveBeenCalled();
    expect(outcome).toEqual({ invited: [], already: [], failed: [] });
  });
});

describe('isAlreadyOnTeam', () => {
  it('recognises the hub’s refusal for an accepted member', () => {
    expect(isAlreadyOnTeam(ALREADY)).toBe(true);
  });

  it('does not swallow an unrelated 400', () => {
    // A malformed address is a real failure and must reach the admin as one.
    expect(isAlreadyOnTeam(hubError(400, 'recipient_email is not a valid email address'))).toBe(false);
  });

  it('does not read a 403 as "already there"', () => {
    expect(isAlreadyOnTeam(hubError(403, 'change_role'))).toBe(false);
  });
});

describe('teamInviteFailureText', () => {
  it('reads the envelope, never the axios message', () => {
    expect(teamInviteFailureText(hubError(400, 'Invitation target not found'), 'Could not invite')).toBe(
      'Invitation target not found',
    );
  });

  it('says a 5xx means invited-but-unmailed, so nobody retries into "already on the team"', () => {
    // The invitation and the role are written before the hub reaches the mail step.
    expect(teamInviteFailureText(hubError(500), 'Could not invite')).toBe('Invited, but the email failed to send');
  });

  it('has a sentence for each of the refusals an admin can actually hit', () => {
    expect(teamInviteFailureText(hubError(401), 'x')).toBe('Sign in to invite people');
    expect(teamInviteFailureText(hubError(403), 'x')).toBe('You cannot invite people to this team');
    expect(teamInviteFailureText(hubError(404), 'x')).toBe('This team no longer exists');
  });

  it('falls back when the hub sends no detail at all', () => {
    expect(teamInviteFailureText(hubError(400), 'Could not invite')).toBe('Could not invite');
  });
});
