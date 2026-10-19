/**
 * Inbound routing — a typed client for the hub's `webhook` chain (flowpad/hub/builtin/webhook.py).
 *
 * The hub owns every claim: a vendor's root (`webhook/@whatsapp`), a number or bot claimed under it (`account`,
 * or a `user` proven by a code), and the sender / group rules chained under a number. Each claim delivers to one
 * place (`target`); a claim with no place (`none`) falls through to its parent's. Nothing here decides a route —
 * this is the screen's data layer, and the hub answers every question.
 *
 * Transport: on the hub page the API base IS the hub, so the `webhook` actions are called directly; on a desktop
 * the local backend forwards each verb to the hub (`data_source/inbound/<verb>`, flow_sdk/app/actions/inbound_action.py).
 */
import { ActionInfo } from '../models/ActionInfo';
import type { HttpMethod } from '../models/ApiUrl';
import { dataManager } from '../APIEntity';
import { isHubOnly } from '../utils/hub-runtime';

/** Where a hub webhook claim hands its messages (the hub's `DeliveryTarget`). `none` = its parent's place. */
export interface ChannelRouteTarget {
  kind: 'none' | 'desktop' | 'node';
  instance_id?: string;
  node_typeid?: string;
  data_source_id?: string;
}

/** One delivery as the claim's owner sees it (never a body or a header). `at` is epoch seconds. */
export interface InboundDelivery {
  at: number;
  method: string;
  sub_path?: string;
  status: number;
}

export type InboundClaimKind = 'root' | 'account' | 'user' | 'group';

/** The hub claim that delivers to a channel, as the owner sees it (never a secret). */
export interface ChannelRouteClaim {
  id: string;
  url: string;
  provider: string;
  status: 'pending' | 'active' | 'lapsed';
  claim?: { kind: InboundClaimKind; key: string } | null;
  target: ChannelRouteTarget;
  deliveries: number;
  misroutes: number;
  recent: InboundDelivery[];
}

/** A claim as `webhook/mine` answers it: everything the owner may see of one chained webhook. */
export interface InboundClaim extends ChannelRouteClaim {
  parent_id: string;
  owner_id?: string;
  depth?: number;
  /** A pending user claim's code — sent from that sender, it proves the claim. */
  code?: string;
  code_expires_at?: number;
  proven_at?: number;
  /** The vendor link that sends the code (pending user claims only). */
  deep_link?: string;
  /** The sender a proven user claim reaches, read back by the hub. */
  sender?: string;
}

/** `POST webhook/chain`. */
export interface InboundChainBody {
  /** `@<provider>` for the vendor's root, or the id of a claim (a number) to chain a rule under. */
  parent: string;
  claim: { kind: 'account' | 'user' | 'group'; key?: string };
  proof?: { credential: string; app_secret?: string; verify_token?: string; graph_url?: string };
  target?: ChannelRouteTarget;
}

/** One hop `probe {phase: reach}` checked. */
export interface InboundHop {
  hop: string;
  ok: boolean;
  detail: string;
}

export interface InboundReach {
  ok: boolean;
  hops: InboundHop[];
}

/** A number or bot (a claim at the vendor's root) with the rules chained under it. */
export interface InboundNumber {
  claim: InboundClaim;
  /** Sender rules first, then group rules — the order the hub matches them in (most specific wins). */
  rules: InboundClaim[];
  /** Where everything no rule matches goes: the number's own place. */
  fallback: ChannelRouteTarget;
}

// ── pure ──────────────────────────────────────────────────────────────────

const SPECIFICITY: Record<string, number> = { user: 0, group: 1, account: 2 };

/**
 * `webhook/mine` → numbers with their rules. A number is a claim whose parent is not one of the caller's own
 * claims (the root is the hub's, never the caller's); a rule is a claim chained under a number.
 */
export function inboundTree(claims: InboundClaim[]): InboundNumber[] {
  const ids = new Set(claims.map((c) => c.id));
  const byParent = new Map<string, InboundClaim[]>();
  for (const c of claims) {
    if (c.parent_id && ids.has(c.parent_id)) {
      byParent.set(c.parent_id, [...(byParent.get(c.parent_id) ?? []), c]);
    }
  }
  const rank = (c: InboundClaim) => SPECIFICITY[c.claim?.kind ?? ''] ?? 9;
  return claims
    .filter((c) => !c.parent_id || !ids.has(c.parent_id))
    .map((claim) => ({
      claim,
      rules: [...(byParent.get(claim.id) ?? [])].sort(
        (a, b) => rank(a) - rank(b) || (a.claim?.key ?? '').localeCompare(b.claim?.key ?? ''),
      ),
      fallback: claim.target ?? { kind: 'none' },
    }))
    .sort(
      (a, b) => (a.claim.provider || '').localeCompare(b.claim.provider || '') || a.claim.id.localeCompare(b.claim.id),
    );
}

/** How many deliveries `claims` recorded at or after `sinceSeconds` (epoch seconds). The hub keeps the latest 50. */
export function receivedSince(claims: InboundClaim | InboundClaim[], sinceSeconds: number): number {
  const list = Array.isArray(claims) ? claims : [claims];
  return list.reduce((n, c) => n + (c.recent ?? []).filter((r) => r.at >= sinceSeconds).length, 0);
}

/** The body that connects a number the caller proves at the vendor (or at their own Meta-API server). */
export function accountChainBody(input: {
  provider: string;
  phoneNumberId: string;
  credential: string;
  appSecret?: string;
  verifyToken?: string;
  graphUrl?: string;
  target?: ChannelRouteTarget;
}): InboundChainBody {
  const proof: InboundChainBody['proof'] = { credential: input.credential.trim() };
  if (input.appSecret?.trim()) proof.app_secret = input.appSecret.trim();
  if (input.verifyToken?.trim()) proof.verify_token = input.verifyToken.trim();
  if (input.graphUrl?.trim()) proof.graph_url = input.graphUrl.trim();
  const body: InboundChainBody = {
    parent: `@${input.provider}`,
    claim: { kind: 'account', key: input.phoneNumberId.trim() },
    proof,
  };
  if (input.target && input.target.kind !== 'none') body.target = input.target;
  return body;
}

/** The body that links the caller's own phone through Flowpad's number: a pending user claim, proven by a code. */
export function linkChainBody(provider: string, target?: ChannelRouteTarget): InboundChainBody {
  const body: InboundChainBody = { parent: `@${provider}`, claim: { kind: 'user' } };
  if (target && target.kind !== 'none') body.target = target;
  return body;
}

/** The body that adds a sender or group rule under a number. */
export function ruleChainBody(
  numberId: string,
  kind: 'user' | 'group',
  key: string,
  target: ChannelRouteTarget,
): InboundChainBody {
  return { parent: numberId, claim: { kind, key: key.trim() }, target };
}

// ── transport ─────────────────────────────────────────────────────────────

function call(method: HttpMethod, verb: string, id: string | null = null): ActionInfo {
  if (isHubOnly()) {
    // `webhook/mine`, `webhook/chain`, `webhook/<id>/<verb>`, `DELETE webhook/<id>`.
    return new ActionInfo(verb, 'webhook', id, method);
  }
  const info = new ActionInfo('inbound', 'data_source', null, method);
  info.subpath = [id, verb].filter(Boolean).join('/');
  return info;
}

/** The hub's `webhook` chain, for the Inbound screen. Every call reads or writes the hub — nothing is cached. */
export const InboundWebhooks = {
  /** Every claim the signed-in person owns. */
  async mine(): Promise<InboundClaim[]> {
    const data = await dataManager.callAction<unknown, { webhooks?: InboundClaim[] }>(call('GET', 'mine'));
    return data?.webhooks ?? [];
  },

  /** Claim a number, a sender or a group. Answers the new claim (a pending user claim carries its code). */
  async chain(body: InboundChainBody): Promise<InboundClaim> {
    const info = call('POST', 'chain');
    info.bodyParameters = body as unknown as Record<string, unknown>;
    return dataManager.callAction<unknown, InboundClaim>(info);
  },

  /** Point one claim somewhere (`none`: its parent's place). Its URL never changes. */
  async setTarget(id: string, target: ChannelRouteTarget): Promise<InboundClaim> {
    const info = call('POST', 'set_target', id);
    info.bodyParameters = { target };
    return dataManager.callAction<unknown, InboundClaim>(info);
  },

  /** Whether a delivery for this claim could reach its place now, hop by hop. Nothing is sent. */
  async probe(id: string): Promise<InboundReach> {
    const info = call('POST', 'probe', id);
    info.bodyParameters = { phase: 'reach' };
    return dataManager.callAction<unknown, InboundReach>(info);
  },

  /** Delete a claim and everything chained under it. */
  async remove(id: string): Promise<void> {
    await dataManager.callAction<unknown, unknown>(call('DELETE', '', id));
  },

  /** This desktop's instance id — what a `desktop` target names. Null on the hub page (no "this computer"). */
  async here(): Promise<string | null> {
    if (isHubOnly()) return null;
    const data = await dataManager.callAction<unknown, { instance_id?: string }>(call('GET', 'here'));
    return data?.instance_id || null;
  },
};

export type InboundApi = typeof InboundWebhooks;
