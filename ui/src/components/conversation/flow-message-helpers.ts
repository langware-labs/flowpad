import { Spec, TypeId, type FlowMessage } from '@sdk';
import { AttachmentType } from '@sdk/entities/flow-message';

/**
 * True when the FlowMessage carries a Spec TypeId either inside its
 * `contextEntities` list or as a TYPE_ID attachment. Used by `MessageBubble`
 * to decide whether to render the Implement Plan / Open Plan Implementation
 * Session affordance on a given bubble.
 */
export function flowMessageHasSpec(fm: FlowMessage | null | undefined): boolean {
  return !!flowMessageSpecTypeId(fm);
}

/**
 * Return the first Spec TypeId carried by this FlowMessage (whether on its
 * `contextEntities` list or as a TYPE_ID attachment), or null when none.
 * `MessageBubble` uses this to wire the View Plan / Implement Plan callbacks
 * to the specific spec the message brought into the conversation.
 */
export function flowMessageSpecTypeId(fm: FlowMessage | null | undefined): TypeId | null {
  if (!fm) return null;
  for (const t of fm.contextEntities ?? []) {
    if (t?.type === Spec.type) return t;
  }
  for (const a of fm.attachment ?? []) {
    if (a.attachment_type !== AttachmentType.TYPE_ID) continue;
    try {
      const tid = new TypeId(a.data);
      if (tid.type === Spec.type) return tid;
    } catch {
      /* malformed — skip */
    }
  }
  return null;
}
