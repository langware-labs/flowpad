import { Spec, TypeId, type FlowMessage } from '@sdk';
import { AttachmentType } from '@sdk/entities/flow-message';

/**
 * True when the FlowMessage carries a Spec TypeId either inside its
 * `sharedContextEntities` list or as a TYPE_ID attachment. Used by
 * `MessageBubble` to decide whether to render the Implement Plan / Open
 * Plan Implementation Session affordance on a given bubble.
 */
export function flowMessageHasSpec(fm: FlowMessage | null | undefined): boolean {
  return !!flowMessageSpecTypeId(fm);
}

/**
 * Return the first Spec TypeId carried by this FlowMessage (whether on its
 * `sharedContextEntities` list or as a TYPE_ID attachment), or null when
 * none. `MessageBubble` uses this to wire the View Plan / Implement Plan
 * callbacks to the specific spec the message brought into the conversation.
 */
export function flowMessageSpecTypeId(fm: FlowMessage | null | undefined): TypeId | null {
  return flowMessageTypeIdOfType(fm, Spec.type);
}

/** GitBranch entity type — the wire vehicle for a shared git repo. No TS
 *  entity class exists for it, so the type string is referenced directly. */
export const GIT_BRANCH_TYPE = 'git_branch';

/**
 * Return the first GitBranch TypeId carried by this FlowMessage (shared
 * context or TYPE_ID attachment), or null. `MessageBubble` uses this to offer
 * the receiver the "Open in Git…" attach/clone affordance.
 */
export function flowMessageGitBranchTypeId(fm: FlowMessage | null | undefined): TypeId | null {
  return flowMessageTypeIdOfType(fm, GIT_BRANCH_TYPE);
}

/** Shared scan: first TypeId of `type` on the message's shared context or its
 *  TYPE_ID attachments, or null. */
function flowMessageTypeIdOfType(fm: FlowMessage | null | undefined, type: string): TypeId | null {
  if (!fm) return null;
  for (const t of fm.sharedContextEntities ?? []) {
    if (t?.type === type) return t;
  }
  for (const a of fm.attachment ?? []) {
    if (a.attachment_type !== AttachmentType.TYPE_ID) continue;
    try {
      const tid = new TypeId(a.data);
      if (tid.type === type) return tid;
    } catch {
      /* malformed — skip */
    }
  }
  return null;
}
