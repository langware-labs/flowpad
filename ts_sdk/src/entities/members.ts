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

/**
 * One person a share addressed: a hub ``user_id``, an email, or both.
 *
 * The share-result shapes below are the wire contract of the ``share`` action's
 * ``share_result`` — the same snake_case field names as the Python
 * ``ShareResultSpec`` (``flow_sdk/schema/data_spec/share_result_spec.py``), which
 * owns the orchestration that produces them.
 */
export interface ShareRecipient {
  user_id: string | null;
  email: string | null;
  name?: string | null;
}

/** A team the share did not expand. Nothing was sent for it. */
export interface SkippedTeam {
  /** The team's typeid string (``team-<uuid>``). */
  team: string;
  name: string | null;
  /**
   * ``not_listable`` — the team's member list refused the sharer (the hub's
   * member-list policy: team admin and above). ``no_members`` — the list came
   * back empty; the local server degrades a refused hub read to its (empty)
   * cached roster, so a refusal can arrive looking exactly like this.
   */
  reason: 'not_listable' | 'no_members' | (string & {});
  message?: string | null;
}

/** The per-person outcome of a share with people and teams. */
export interface ShareResult {
  /** Invited; ``conversation_id`` is the conversation the hub opened with the sharer. */
  invited: (ShareRecipient & { conversation_id: string | null })[];
  /** ``self`` | ``already_member`` | ``already_invited`` | the hub's own reason. */
  skipped: (ShareRecipient & { reason: string })[];
  /** The hub refused or failed this one; ``status`` is null when no response came back. */
  failed: (ShareRecipient & { status: number | null; message: string })[];
  skipped_teams: SkippedTeam[];
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

/**
 * Redeem a shareable invite link — POST ``members/redeem`` (typeless).
 *
 * The token rides as the POST body, never a query string: beyond keeping it out
 * of logs/history/Referer, the hub's graph router merges query params over the
 * body, so a query param would silently override the field. Authenticated-only
 * by design (anonymous → 401; the ``/invite/<token>`` page owns the login
 * bounce). Returns the server-chosen, open-redirect-validated landing URL.
 */
export async function redeemInviteLink(token: string): Promise<{ redirect_url: string }> {
  const info = new ActionInfo('members', null, null, 'POST');
  info.subpath = 'redeem';
  info.hubReflect = true; // links are hub-owned — reflect to the hub
  info.bodyParameters = { token };
  return await dataManager.callAction<unknown, { redirect_url: string }>(info);
}
