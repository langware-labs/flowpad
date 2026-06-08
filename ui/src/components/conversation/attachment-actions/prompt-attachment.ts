import { Prompt, TypeId, type FlowMessage } from '@sdk';
import { AttachmentType, attachmentDataString, type Attachment } from '@sdk/entities/flow-message';

/**
 * Prompt attachments come in two generations:
 *   - legacy `AttachmentType.PROMPT` — inline text or a `prompt/<file>` VFS path
 *   - entity-backed `TYPE_ID` entries pointing at a library `prompt` entity,
 *     carrying `prompt_preview` (inline copy) + `proposer_id`/`approved_by`.
 * These helpers are the single place that knows both shapes — mirrors the
 * backend's `_is_prompt_attachment` (notification_action.py); both sides key
 * on the entity type `Prompt.type` ('prompt').
 */

/** Entity id of a prompt-entity TYPE_ID attachment, or null for anything else. */
export function promptEntityIdOf(a: Attachment): string | null {
  if (a.attachment_type !== AttachmentType.TYPE_ID) return null;
  // data is "<type>-<id>"; type is everything before the first dash.
  const d = attachmentDataString(a);
  const dash = d.indexOf('-');
  if (dash <= 0 || d.slice(0, dash) !== Prompt.type) return null;
  return d.slice(dash + 1);
}

export function isPromptEntityAttachment(a: Attachment): boolean {
  return promptEntityIdOf(a) !== null;
}

export function isPromptAttachment(a: Attachment): boolean {
  return a.attachment_type === AttachmentType.PROMPT || isPromptEntityAttachment(a);
}

/** Every prompt attachment (both generations) on the message. */
export function promptAttachmentsOf(fm: FlowMessage | null | undefined): Attachment[] {
  return (fm?.attachment ?? []).filter(isPromptAttachment);
}

/** Index of the first unapproved prompt attachment, or -1. */
export function firstUnapprovedPromptIdx(fm: FlowMessage | null | undefined): number {
  return (fm?.attachment ?? []).findIndex((a) => isPromptAttachment(a) && !a.approved_by);
}

/** TypeId of the first prompt-entity attachment, or null. */
export function flowMessagePromptEntityTypeId(fm: FlowMessage | null | undefined): TypeId | null {
  for (const att of fm?.attachment ?? []) {
    const id = promptEntityIdOf(att);
    if (id) return new TypeId(Prompt.type, id);
  }
  return null;
}
