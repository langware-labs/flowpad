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
  // local body and returns only cached ``participants`` (empty for an org/team,
  // which keep no local roster), so the member list renders blank. The reflect
  // gate still falls back to the local body when the entity is local-only or the
  // hub is unreachable.
  info.hubReflect = true;
  const res = await dataManager.callAction<undefined, Participant[]>(info);
  // Defensive: the hub utils coerce empty lists to {} upstream
  // (`resp.json().get('data') or {}` in flow_sdk/utils/hub.py). Treat any
  // non-array response as "no members" so consumers can rely on Participant[].
  return Array.isArray(res) ? res : [];
}
