/**
 * Emailing the people who hold a budget in a team — the writes, kept out of the table so they can
 * be tested without rendering anything (`share-endpoint.ts` is the model this follows).
 *
 * **The invitation is to the TEAM, never to the budget.** Adding someone through "Add people"
 * grants them the endpoint at `reader` with `notifyByEmail: false` (see `share-endpoint.ts` for
 * why), and auto-accept writes that edge immediately — so re-inviting them to the ENDPOINT is
 * refused by the hub with 400 `"User has already accepted; use change_role to change their role."`
 * and `shareEndpointByEmail` counts that refusal as a success. A "Send invite" button built on the
 * endpoint would therefore report "sent" and send nothing, for exactly the people an admin most
 * wants to reach. The team is a target they do not yet hold, so the invitation is genuinely minted
 * and the mail genuinely goes out.
 *
 * Three kinds of recipient, all of which reach here from the same table:
 *
 * * **No account yet** — the hub provisions an `invited` shadow user and mails them a link that
 *   signs them up on accept. This is the case the button exists for.
 * * **An account, not on this team** — ordinary invitation; the role lands on accept (or at once,
 *   under auto-accept) and the mail goes out either way.
 * * **Already on this team** — the hub refuses with 400, and that refusal is reported as its own
 *   outcome (`already`), not as a failure and never as a success. Someone who was put on the team
 *   WITHOUT an invitation (a group grant, or the team's creator) has no accepted Invitation for the
 *   hub to find, so they are re-invited normally — which is the resend an admin asked for.
 *
 * Nothing aborts on the first failure: the hub takes one recipient per POST, the addresses are
 * independent, and an admin mailing thirty people needs to know which one bounced.
 */
import { Layout, PageId, TypeId, ViewType, dataManager } from '@sdk';

import { errorDetail, errorStatus } from '@src/lib/error-message';

/** What an invitation to a team confers. Not from the `Role` enum: `member` is the hub's own
 *  default for `inviteMember` and is deliberately off that enum, which carries the standard ladder
 *  the UI picks from. The role is named explicitly so the call site is not reading a default. */
export const TEAM_INVITE_ROLE = 'member';

export interface TeamInviteOutcome {
  /** An invitation was minted and the hub sent (or is sending) the mail. */
  invited: string[];
  /** Already an accepted member of this team — no mail, and nothing to do. */
  already: string[];
  failed: { email: string; reason: string }[];
}

/** Where the recipient lands after accepting. Without a `callback_override` the hub falls back to
 *  the team's bare entity URL, which the SPA has no route for — the click would land nowhere. */
export function teamInviteLandingPath(): string {
  return `/${Layout.DOCK}/${PageId.HUB}/${ViewType.ORGANIZATION}`;
}

/**
 * Did this fail only because they are already on the team?
 *
 * The hub refuses to re-invite someone who accepted — `change_role` is the only path for a role
 * change — and answers 400 naming it. Reporting that as a failure would send an admin hunting for
 * a bug; reporting it as a success would claim an email that never left.
 */
export function isAlreadyOnTeam(error: unknown): boolean {
  return errorStatus(error) === 400 && /already accepted|change_role/i.test(errorDetail(error));
}

/**
 * Turn a thrown hub failure into a sentence an admin can act on.
 *
 * Reads the error ENVELOPE, never `err.message`: the client rethrows the raw AxiosError, whose
 * message is always "Request failed with status code 4xx".
 */
export function teamInviteFailureText(error: unknown, fallback: string): string {
  const status = errorStatus(error);
  const detail = errorDetail(error);
  if (status === 401) return 'Sign in to invite people';
  if (status === 403) return detail || 'You cannot invite people to this team';
  if (status === 404) return detail || 'This team no longer exists';
  // The invitation and the role are written before the hub reaches the mail step, so a 5xx there
  // means the person WAS invited and only the notification failed. Saying "could not invite" would
  // invite a retry that then reports "already on the team".
  if (status >= 500) return 'Invited, but the email failed to send';
  return detail || fallback;
}

/**
 * Invite every address to `teamId`, concurrently, and report each one's outcome.
 *
 * The team is loaded as an ENTITY first because `inviteMember` is a method on the model, and
 * `dataManager` is cache-first — the same reason `removeTeam` in `BudgetSection` fetches before it
 * deletes. A team row on the budgets page comes from the `budgets` aggregate (a DTO), so it has
 * never been through the entity cache.
 */
export async function inviteToTeamByEmail(teamId: string, emails: readonly string[]): Promise<TeamInviteOutcome> {
  const outcome: TeamInviteOutcome = { invited: [], already: [], failed: [] };
  if (emails.length === 0) return outcome;

  const typeId = new TypeId('team', teamId);
  let team: { inviteMember: (email: string, role: string, opts?: object) => Promise<void> };
  try {
    team = (await dataManager.getByTypeId(typeId)) as never;
  } catch (err) {
    // One unreachable team is every address failing for the same reason — said once per address so
    // the table can mark each row rather than showing a bare toast with no rows attached.
    const reason = teamInviteFailureText(err, 'Could not open this team');
    return { invited: [], already: [], failed: emails.map((email) => ({ email, reason })) };
  }

  const callbackOverride = teamInviteLandingPath();
  const results = await Promise.allSettled(
    emails.map((email) => team.inviteMember(email, TEAM_INVITE_ROLE, { callbackOverride })),
  );
  results.forEach((result, i) => {
    const email = emails[i];
    if (result.status === 'fulfilled') {
      outcome.invited.push(email);
    } else if (isAlreadyOnTeam(result.reason)) {
      outcome.already.push(email);
    } else {
      outcome.failed.push({ email, reason: teamInviteFailureText(result.reason, 'Could not invite') });
    }
  });
  return outcome;
}
