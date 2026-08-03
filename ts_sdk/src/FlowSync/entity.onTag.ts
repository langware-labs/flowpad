import { EventBus } from '../tags/EventBus';
import { IEntity } from '../IEntity';
import { TypeId } from '../models/TypeId';

const OP_TO_TAG: Record<string, string> = {
  create: 'app.entity.created',
  update: 'app.entity.updated',
  delete: 'app.entity.deleted',
  // Subtree ops keep their own tags rather than collapsing into `updated`: the
  // target is the PARENT but the thing that changed is a child, and a
  // subscriber has to be able to tell those apart. Mirrors the backend's
  // `_OP_TO_SUBTAG` in flow_sdk/db/entity_on_tag.py.
  child_created: 'app.entity.child_created',
  child_updated: 'app.entity.child_updated',
  child_deleted: 'app.entity.child_deleted',
};

/**
 * The entity-family bus adapter (see docs/tags.md, "legacy adapters"): the
 * entity pipeline already delivers every `data_op_msg` to this tab, so the
 * app-local bus gets its `app.entity.*` wake-ups by re-emitting at the
 * DataManager seam — zero backend change. Strictly synchronous, called AFTER
 * DataManager's own invalidation handling.
 *
 * Events are wake-ups, not proofs: gating consumers (journey awaits) confirm
 * against the store before acting.
 */
export function emitEntityTag(typeId: TypeId, op: string, data: IEntity | null): void {
  const tag = OP_TO_TAG[op];
  if (!tag) return;
  EventBus.emit(tag, `${typeId.type}:${typeId.id}`, { entity: data }, { origin: 'app' });
}
