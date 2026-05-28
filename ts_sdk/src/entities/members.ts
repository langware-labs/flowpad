import { dataManager } from '../APIEntity';
import { ActionInfo } from '../models/ActionInfo';
import { TypeId } from '../models/TypeId';

/**
 * A participant on any shareable entity. Returned by the generic ``members``
 * action; same shape regardless of the entity type. ``ConversationParticipant``
 * is structurally compatible — the conversation cache uses the same fields.
 */
export interface Participant {
  user_id?: string | null;
  email?: string | null;
  name?: string | null;
  role?: string | null;
}

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
  const res = await dataManager.callAction<undefined, Participant[]>(info);
  // Defensive: the hub utils coerce empty lists to {} upstream
  // (`resp.json().get('data') or {}` in flow_sdk/utils/hub.py). Treat any
  // non-array response as "no members" so consumers can rely on Participant[].
  return Array.isArray(res) ? res : [];
}
