import { Conversation, dataManager, FlowMessage, TypeId } from '@sdk';
import { AttachmentType } from '@sdk/entities/flow-message';

export interface ConversationTranscriptInfo {
  /** FlowMessage id whose attachment list contains the transcript file. */
  messageId: string;
  /** VFS subpath of the attachment, e.g. `data/conversation.jsonl`. */
  vfsPath: string;
}

/**
 * Walk a conversation's pointer list and return the first FlowMessage whose
 * attachment list contains a `conversation.jsonl` FILE attachment, or null
 * when no message in the thread carries one.
 *
 * Used by the conversation toolbar to surface the sender's Claude Code
 * transcript as a top-level "Transcript File" link instead of burying it
 * inside the originating message bubble.
 */
export async function findConversationTranscript(
  conversationId: string,
): Promise<ConversationTranscriptInfo | null> {
  try {
    const conv = await dataManager.getByTypeId<Conversation>(
      new TypeId(Conversation.type, conversationId),
    );
    const pointers = conv?.conversationMessageIds ?? [];
    for (const ptr of pointers) {
      const fm = await dataManager
        .getByTypeId<FlowMessage>(new TypeId(FlowMessage.type, ptr.id))
        .catch(() => null);
      if (!fm) continue;
      const att = (fm.attachment ?? []).find(
        (a) => a.attachment_type === AttachmentType.FILE && a.data.endsWith('conversation.jsonl'),
      );
      if (att) return { messageId: ptr.id, vfsPath: att.data };
    }
  } catch {
    // fall through — the toolbar treats null as "no transcript yet".
  }
  return null;
}
