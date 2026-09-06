/**
 * Sharing an LLM budget by email — the logic, kept out of the dialog so it can be tested
 * without rendering anything.
 *
 * The write is `endpoint.inviteMember(email, reader)` — `POST /graph/llm_endpoint/<id>/members`,
 * the same call every other shareable entity makes (`share-sandbox.ts`, which this module was
 * modelled on). The hub does the rest: it mints an Invitation, provisions a shadow account if the
 * address has never signed in, sends the mail, and grants the role on accept.
 *
 * It is deliberately NOT `endpoint.share([email])`. That reaches the LOCAL server's generic
 * `share` action, which exists only in `flow_sdk`; the hub's API is a strict subset of it and
 * registers no `share` (see `hub-runtime.ts`). So the SDK one-liner works from the desktop app
 * and 400s with "Post not supported for this path" on the `/dock/hub/llm-endpoints` page, which
 * is served straight off the hub. `members` is registered `types="all"` and routes on both.
 *
 * Sharing a budget sends NO email (`notifyByEmail: false`). Auto-accept is on for every entity
 * type, so the `reader` edge is written before the mail step would run — the recipient already has
 * the budget and finds it in their own listing. The mail would announce a fait accompli, and a
 * budget is handed over in a conversation ("here is your $1"), not discovered in an inbox. The hub
 * still mints the Invitation, so nothing else about the grant changes.
 *
 * `reader` is the entire security story of sharing money: the hub's `llm_endpoint` policy gives
 * it `read, invoke, models, chain, usage`. The recipient can spend the budget and watch it
 * drain; they cannot raise its limits, swap the provider key underneath the owner, allocate
 * themselves an uncapped sibling, or pass it on.
 *
 * Naming the role here rather than in Python is not a downgrade: `members` on an `llm_endpoint`
 * is owner-only, and the hub authorizes every grant through `can_assign` by principal type and
 * rank — an owner could already confer `admin` through the API. `share-sandbox.ts` holds its own
 * role constant for the same reason.
 */
import { Role, type LLMEndpoint } from '@sdk';

import { errorDetail, errorStatus } from '@src/lib/error-message';

import { endpointShareLandingPath } from './llm-endpoints-pointer';

/** What a share confers: spend and watch, never configure. The hub's `llm_endpoint` policy is
 *  keyed on this exact string, so it comes from the shared `Role` enum rather than a literal —
 *  the same value `SHARE_ROLE` pins on the Python side (`HubRole.READER`). */
export const ENDPOINT_SHARE_ROLE = Role.READER;

export interface ShareEndpointFailure {
  email: string;
  reason: string;
  /**
   * Did the role edge land anyway?
   *
   * True for the 5xx case ONLY: auto-accept writes the grant before the mail step runs, so a
   * failure there is a failed EMAIL on top of a successful share. It is reported so the caller can
   * tell the two apart -- `addOne` undoes its allocation when a share fails, and undoing it here
   * would delete a budget the recipient can already reach.
   */
  accessLanded: boolean;
}

export interface ShareEndpointOutcome {
  granted: string[];
  failed: ShareEndpointFailure[];
}

/** Did the grant survive the failure? See `ShareEndpointFailure.accessLanded`. */
function accessLandedDespite(error: unknown): boolean {
  return errorStatus(error) >= 500;
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
  endpoint: Pick<LLMEndpoint, 'inviteMember' | 'id'>,
  emails: string[],
): Promise<ShareEndpointOutcome> {
  const callbackOverride = endpointShareLandingPath(endpoint.id);
  const results = await Promise.allSettled(
    emails.map((email) =>
      endpoint.inviteMember(email, ENDPOINT_SHARE_ROLE, { callbackOverride, notifyByEmail: false }),
    ),
  );
  const outcome: ShareEndpointOutcome = { granted: [], failed: [] };
  results.forEach((result, i) => {
    const email = emails[i];
    if (result.status === 'fulfilled' || isAlreadyMember(result.reason)) {
      outcome.granted.push(email);
      return;
    }
    outcome.failed.push({
      email,
      reason: shareEndpointFailureText(result.reason, 'Could not share'),
      accessLanded: accessLandedDespite(result.reason),
    });
  });
  return outcome;
}
