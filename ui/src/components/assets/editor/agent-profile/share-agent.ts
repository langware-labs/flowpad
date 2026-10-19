/**
 * Sharing an agent by email — `agent.inviteMember(email, reader)`, i.e.
 * `POST /graph/agent/<id>/members`, hub-reflected. The hub mints the Invitation, provisions a
 * shadow account for an unknown address, sends the mail and writes the role edge on the agent.
 *
 * `reader` on the hub's `agent` policy: read the row and download its files — no update, deploy,
 * or re-share. Same shape as `share-endpoint.ts`, which this module mirrors.
 */
import { Agent, Role } from '@sdk';

import { errorDetail, errorStatus } from '@src/lib/error-message';

export const AGENT_SHARE_ROLE = Role.READER;

export interface ShareAgentFailure {
  email: string;
  reason: string;
}

export interface ShareAgentOutcome {
  granted: string[];
  failed: ShareAgentFailure[];
}

/** Where the invitation email lands: the hub's own agent page. */
export function agentShareLandingPath(agentId: string): string {
  return `/${Agent.type}/${encodeURIComponent(agentId)}`;
}

/** The hub refuses to re-invite an existing member (400 naming `change_role`) — access is already there. */
function isAlreadyMember(error: unknown): boolean {
  return errorStatus(error) === 400 && /change_role/i.test(errorDetail(error));
}

export function shareAgentFailureText(error: unknown, fallback: string): string {
  const status = errorStatus(error);
  const detail = errorDetail(error);
  if (status === 401) return 'Sign in to share this agent';
  if (status === 403) return detail || 'Only the agent’s owner can share it';
  // The role is granted before the mail step, so a 5xx here is a failed email, not a failed share.
  if (status >= 500) return 'Access granted, but the invitation email failed to send';
  return detail || fallback;
}

/** Invite every address independently; one rejection never aborts the rest. */
export async function shareAgentByEmail(
  agent: Pick<Agent, 'inviteMember' | 'id'>,
  emails: string[],
): Promise<ShareAgentOutcome> {
  const callbackOverride = agentShareLandingPath(agent.id);
  const results = await Promise.allSettled(
    emails.map((email) => agent.inviteMember(email, AGENT_SHARE_ROLE, { callbackOverride })),
  );
  const outcome: ShareAgentOutcome = { granted: [], failed: [] };
  results.forEach((result, i) => {
    const email = emails[i];
    if (result.status === 'fulfilled' || isAlreadyMember(result.reason)) {
      outcome.granted.push(email);
    } else {
      outcome.failed.push({ email, reason: shareAgentFailureText(result.reason, 'Could not share') });
    }
  });
  return outcome;
}
