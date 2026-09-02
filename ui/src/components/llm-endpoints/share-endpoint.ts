/**
 * Sharing an LLM budget by email — the logic, kept out of the dialog so it can be tested
 * without rendering anything.
 *
 * The whole write is `endpoint.share([email])`, the ts_sdk one-liner. It reaches the local
 * server's generic `share` action, which for a hub-only entity forwards a standard
 * `MembershipRequest` to `POST /graph/llm_endpoint/<id>/members`. The hub does the rest: it
 * mints an Invitation, provisions a shadow account if the address has never signed in, sends
 * the mail, and grants `reader` on accept.
 *
 * `reader` is the entire security story of sharing money: the hub's `llm_endpoint` policy gives
 * it `read, invoke, models, chain, usage`. The recipient can spend the budget and watch it
 * drain; they cannot raise its limits, swap the provider key underneath the owner, allocate
 * themselves an uncapped sibling, or pass it on. The role is chosen on the Python side so it
 * cannot be talked up from a client.
 */
import type { LLMEndpoint } from '@sdk';

import { errorDetail, errorStatus } from '@src/lib/error-message';

export interface ShareEndpointOutcome {
  granted: string[];
  failed: { email: string; reason: string }[];
}

/**
 * Did this fail only because the person already holds the role?
 *
 * The hub refuses to re-invite an existing member — `change_role` is the only path for one — and
 * answers 400 naming it. That is not a failed share: the access being asked for is already there,
 * and reporting it as an error would push the sender into a pointless retry.
 */
function isAlreadyMember(error: unknown): boolean {
  return errorStatus(error) === 400 && /change_role/i.test(errorDetail(error));
}

/**
 * Turn a thrown hub failure into a sentence the sender can act on.
 *
 * Reads the error ENVELOPE, never `err.message`: the client rethrows the raw AxiosError, whose
 * message is always "Request failed with status code 4xx".
 *
 * The 403 wording is specific for a reason. On an `llm_endpoint`, `members` is owner-only — an
 * `admin` may re-budget the endpoint, replace its key and allocate from it, yet still cannot give
 * it away. That is surprising enough that a generic "forbidden" would send someone hunting for a
 * bug that is not there.
 */
export function shareEndpointFailureText(error: unknown, fallback: string): string {
  const status = errorStatus(error);
  const detail = errorDetail(error);
  if (status === 401) return 'Sign in to share this budget';
  if (status === 403) return detail || 'Only the budget’s owner can share it';
  // The role is granted before the mail step, so the access DID land. Calling this a failed share
  // would be wrong and would invite a retry that then reports "already has access".
  if (status >= 500) return 'Access granted, but the invitation email failed to send';
  return detail || fallback;
}

/**
 * Invite every address, concurrently, and report each one's outcome.
 *
 * The hub takes exactly one `recipient_email` per POST, so a batch is N requests however it is
 * spelled — but they are independent (distinct addresses, one Invitation and one role edge each,
 * no ordering between them), so `allSettled` turns N round-trips of latency into one while keeping
 * what the sequential loop was for: nothing aborts on the first rejection, and the sender is told
 * exactly which addresses took.
 */
export async function shareEndpointByEmail(
  endpoint: Pick<LLMEndpoint, 'share'>,
  emails: string[],
): Promise<ShareEndpointOutcome> {
  const results = await Promise.allSettled(emails.map((email) => endpoint.share([email])));
  const outcome: ShareEndpointOutcome = { granted: [], failed: [] };
  results.forEach((result, i) => {
    const email = emails[i];
    if (result.status === 'fulfilled' || isAlreadyMember(result.reason)) {
      outcome.granted.push(email);
      return;
    }
    outcome.failed.push({ email, reason: shareEndpointFailureText(result.reason, 'Could not share') });
  });
  return outcome;
}
