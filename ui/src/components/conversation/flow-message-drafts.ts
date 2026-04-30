import { dataManager, FlowMessage, TypeId } from '@sdk';
import { ActionInfo } from '@sdk/models/ActionInfo';

/** URL pointing at the local-only `.flowmsg` zip download for `messageId`. */
export function localBundleUrl(messageId: string): string {
  return new ActionInfo('create-and-download-local-flowmsg', 'flow_message', messageId, 'GET').fullActionUrl;
}

/**
 * Promote a draft FlowMessage to a real reply.
 *
 * If `nextText` differs from the persisted body, it is saved first so the
 * recipient sees the latest edit. Calls the backend `send-draft` action which
 * appends to conversation.jsonl, pushes to hub, and flips `is_draft=false`.
 */
export async function sendDraftFlowMessage(fm: FlowMessage, nextText?: string): Promise<void> {
  if (!fm.id) throw new Error('Cannot send a draft without an id');
  if (typeof nextText === 'string' && fm.text !== nextText) {
    fm.text = nextText;
    await fm.save();
  }
  const action = new ActionInfo('send-draft', 'flow_message', fm.id, 'POST');
  await dataManager.callAction(action);
}

/** Delete a draft FlowMessage entity. */
export async function discardDraftFlowMessage(fm: FlowMessage): Promise<void> {
  await fm.delete();
}

/** Convenience: load a draft by id (used when the caller only has the id). */
export async function loadDraft(messageId: string): Promise<FlowMessage | null> {
  return dataManager.getByTypeId<FlowMessage>(new TypeId(FlowMessage.type, messageId)).catch(() => null);
}
