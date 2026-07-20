import { dataManager, type EntityMember } from '../APIEntity';
import { ActionInfo } from '../models/ActionInfo';
import { TypeId } from '../models/TypeId';

/**
 * A participant on any shareable entity. Alias of ``EntityMember`` (the shape
 * ``APIEntity.fetchMembers`` returns) — kept as a named export for existing
 * import sites. ``ConversationParticipant`` is structurally compatible.
 * Carries the open ``status`` / passthrough keys so callers reading hub
 * fields (e.g. pending-vs-approved) don't have to cast.
 */
export type Participant = EntityMember;

/**
 * Fetch the member list for any entity. Hits ``GET /api/v1/graph/<type>/<id>/members``.
 *
 * When the entity has ``remote=true`` the local server forwards the call to
 * the hub and mirrors the response onto the local row (see ``_hub_reflect.py``
 * in flow_sdk). When the entity is local-only or the hub is unreachable, the
 * local server returns whatever participants the entity has cached — possibly
 * an empty list.
 */
export async function getMembers(typeId: TypeId): Promise<Participant[]> {
  const info = new ActionInfo('members', typeId.type, typeId.id, 'GET');
  // The roster is hub-owned for remote entities — opt this read into reflection
  // (mirrors ``APIEntity.fetchMembers``). Without it the dispatcher runs the
  // local body and returns only the cached ``members`` roster (which is now a
  // generic Entity-base field, so org/team cache it too). The reflect gate still
  // falls back to the local body when the entity is local-only or the hub is
  // unreachable — a stale roster read beats an error.
  info.hubReflect = true;
  const res = await dataManager.callAction<undefined, Participant[]>(info);
  // Defensive: the hub utils coerce empty lists to {} upstream
  // (`resp.json().get('data') or {}` in flow_sdk/utils/hub.py). Treat any
  // non-array response as "no members" so consumers can rely on Participant[].
  return Array.isArray(res) ? res : [];
}

/** A freshly minted invite link. ``url`` is returned EXACTLY ONCE — the hub
 *  stores only a hash of the token, so nothing can hand it back later. */
export interface InviteLink {
  id: string;
  /** App route (``<hub>/invite/<token>``), not a raw token. */
  url: string;
  expiration_at: string | null;
  allowed_email_domains: string[];
}

/**
 * Mint a shareable invite link for any entity — POST ``<type>/<id>/members/link``.
 *
 * Anyone holding the URL can redeem it to invite themselves at ``role``, so it
 * is shown once at mint and never again: only the token's hash is stored
 * hub-side. Copy it immediately; to "recover" one, mint a new link and revoke
 * the old.
 *
 * Hub-gated: admin+ (the ``members`` policy) and a per-target grant ceiling —
 * minting above your own role is a 403, which throws here. The entity must
 * already exist hub-side (``remote``); publish it with ``share()`` first, or
 * reflection falls through to the local no-op and this silently returns
 * nothing.
 *
 * Expiry and domain allowlist are left to the hub (it defaults, and clamps
 * expiry to ``invitation_max_expiry_days``).
 */
export async function mintInviteLink(typeId: TypeId, role: string = 'member'): Promise<InviteLink> {
  const info = new ActionInfo('members', typeId.type, typeId.id, 'POST');
  info.subpath = 'link';
  info.hubReflect = true; // links are hub-owned — reflect to the hub
  info.bodyParameters = {
    invitation_targets: [{ typeid: `${typeId.type}-${typeId.id}`, role }],
  };
  return await dataManager.callAction<unknown, InviteLink>(info);
}
