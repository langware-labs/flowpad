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
}

/** One team a share addressed. */
export interface ShareTeam {
  /** The team's typeid string (``team-<uuid>``). */
  team: string;
  name: string | null;
}

/** A team granted on the hub as ONE group principal. */
export interface GrantedTeam extends ShareTeam {
  /** The team invite conversation; null when the grant landed but the message was not sent. */
  conversation_id: string | null;
}

/** A team that already holds a role on the entity: no second grant, conversation or message. */
export interface SkippedTeam extends ShareTeam {
  reason: 'already_granted';
}

/** A team whose group grant the hub refused; ``status`` is null when no response came back. */
export interface FailedTeam extends ShareTeam {
  status: number | null;
  message: string;
}

/** The per-person and per-team outcome of a share with people and teams. */
export interface ShareResult {
  /** Invited; ``conversation_id`` is the 1:1 invite conversation the sharer's client opened. */
  invited: (ShareRecipient & { conversation_id: string | null })[];
  /** ``self`` | ``already_member`` | ``already_invited``. */
  skipped: (ShareRecipient & { reason: string })[];
  /** The hub refused or failed this one; ``status`` is null when no response came back. */
  failed: (ShareRecipient & { status: number | null; message: string })[];
  granted_teams: GrantedTeam[];
  skipped_teams: SkippedTeam[];
  failed_teams: FailedTeam[];
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
