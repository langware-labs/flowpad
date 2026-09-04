/**
 * Putting people on a team's budget — the writes, kept out of the dialog so they can be tested
 * without rendering anything (`share-endpoint.ts` is the model this follows).
 *
 * Adding someone is two calls, and which two depends on whether they already draw on this pool:
 *
 * * **New:** `allocate` on the TEAM POOL — the only way a source link comes into being, and the
 *   hub authorizes it against the pool being drawn from — then `shareEndpointByEmail`, which grants
 *   `reader` (spend it, never raise it) and works for an address that has never signed in: the hub
 *   provisions a shadow account. That is what makes a CSV of new hires work at all. `allocate`'s
 *   own `grant_to` cannot do this — it needs an account that already exists.
 * * **Already here:** their allowance is UPDATED in place. Re-uploading a corrected sheet is how a
 *   whole team gets re-budgeted, so a repeated address must not mint a second wallet for the same
 *   person. This is matched on the email the hub already resolved, so it also catches the hub's own
 *   per-user default rather than shadowing it with a duplicate.
 *
 * Nothing here aborts on the first failure: rows are independent, and someone importing forty
 * people needs to know which one bounced, not to lose the other thirty-nine.
 */
import { LLMEndpoint, TypeId, dataManager, llmEndpointsService } from '@sdk';

import { endpointIdFromTypeId } from '@src/components/llm-endpoints/llm-endpoints-pointer';
import { shareEndpointByEmail } from '@src/components/llm-endpoints/share-endpoint';
import { errorMessage } from '@src/lib/error-message';

import type { MemberBudget } from '@sdk';

export interface PersonDraft {
  name: string;
  /** Lower-cased; `parsePeopleCsv` already normalises, the manual rows are normalised here. */
  email: string;
  /** Lifetime allowance in USD; `null` = no cap. */
  budget: number | null;
}

export interface AddPeopleOutcome {
  added: string[];
  updated: string[];
  failed: { email: string; reason: string }[];
}

/**
 * How many rows are written at once. A forty-row CSV is eighty requests, and firing them all at
 * the hub in one breath is how a bulk import turns into a rate-limit incident; ten at a time keeps
 * an import that is worth parallelising from becoming a burst.
 */
const WRITE_CHUNK = 10;

/** Set one endpoint's lifetime cap. `limits` is a MERGED update on the hub, so naming the one field
 *  leaves every other limit alone — restating them is how they get silently blanked. */
export async function setLifetimeCap(endpointTypeId: string, usd: number | null): Promise<void> {
  await dataManager.save<LLMEndpoint>(new TypeId(endpointTypeId), [], {
    limits: { cost_usd_total: usd },
  } as never);
}

/** Remove one person's allowance entirely. */
export async function removeAllowance(endpointTypeId: string): Promise<void> {
  await dataManager.delete(new TypeId(endpointTypeId));
}

export function indexByEmail(members: readonly MemberBudget[]): Map<string, MemberBudget> {
  const byEmail = new Map<string, MemberBudget>();
  for (const member of members) {
    const email = member.email?.trim().toLowerCase();
    if (email && !byEmail.has(email)) byEmail.set(email, member);
  }
  return byEmail;
}

async function addOne(poolId: string, draft: PersonDraft): Promise<void> {
  // The hub hands out typeids (`llm_endpoint-<uuid>`) while an action URL takes the bare uuid --
  // a typeid in the path answers 422, and it is the same normalisation `MembersTable` documents.
  const created = await llmEndpointsService.allocate(endpointIdFromTypeId(poolId), {
    name: draft.name.trim() || draft.email,
    limits: { cost_usd_total: draft.budget } as never,
  });
  // `allocate` answers with the entity's JSON, not a live model, and the invite is a method on the
  // model — so it is rehydrated rather than called on the raw payload.
  const allocation = new LLMEndpoint(created as never);
  const { failed } = await shareEndpointByEmail(allocation, [draft.email]);
  if (failed.length > 0) {
    // The wallet exists but nobody can reach it. Say so plainly instead of reporting a success the
    // owner would only discover was hollow when the person said "I can't see any budget".
    throw new Error(failed[0].reason);
  }
}

/**
 * Write every draft against `poolTypeId`, reporting each one's outcome.
 *
 * `existing` is the team's current roster — the caller already has it from `teamBudgets`, so the
 * add/update decision costs no extra read.
 */
export async function addPeopleToTeam(
  poolTypeId: string,
  drafts: readonly PersonDraft[],
  existing: readonly MemberBudget[],
): Promise<AddPeopleOutcome> {
  const byEmail = indexByEmail(existing);
  const outcome: AddPeopleOutcome = { added: [], updated: [], failed: [] };

  for (let start = 0; start < drafts.length; start += WRITE_CHUNK) {
    const batch = drafts.slice(start, start + WRITE_CHUNK);
    const results = await Promise.allSettled(
      batch.map((draft) => {
        const already = byEmail.get(draft.email);
        return already ? setLifetimeCap(already.endpoint_id, draft.budget) : addOne(poolTypeId, draft);
      }),
    );
    results.forEach((result, i) => {
      const draft = batch[i];
      if (result.status === 'rejected') {
        outcome.failed.push({ email: draft.email, reason: errorMessage(result.reason, 'Could not add') });
      } else if (byEmail.has(draft.email)) {
        outcome.updated.push(draft.email);
      } else {
        outcome.added.push(draft.email);
      }
    });
  }
  return outcome;
}
