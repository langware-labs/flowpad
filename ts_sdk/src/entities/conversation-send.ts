import { sendReply } from './notifications';
import {
  Conversation,
  ConversationParticipant,
  createProjectConversation,
} from './conversation';

/**
 * Unified send payload. ``text`` may be empty when ``assetReferences`` or
 * ``files`` carry the meaning (e.g. share-a-doc with no commentary).
 */
export interface ConversationSendPayload {
  text: string;
  files?: File[];
  /** Serialized TypeIds (e.g. ``"markdown-<uuid>"``) for TYPE_ID attachments. */
  assetReferences?: string[];
}

/** Send into an already-existing conversation. Thin wrap over ``sendReply``. */
export async function sendToExistingConversation(
  conversationId: string,
  payload: ConversationSendPayload,
): Promise<void> {
  await sendReply(
    { conversationId },
    payload.text,
    payload.files,
    payload.assetReferences?.length
      ? { assetReferences: payload.assetReferences }
      : undefined,
  );
}

export interface CreateAndSendParams {
  /** Required for project-local conversations; null for cross-user bundle. */
  project_id?: string | null;
  participants: ConversationParticipant[];
  title?: string;
}

export interface CreateAndSendResult {
  conversation_id: string;
}

/**
 * Cross-user routing predicate: a conversation is delivered through the hub
 * bundle path (vs. project-local) when *any* participant carries a user_id
 * or an @-email — i.e. could be a different machine.
 */
export const hasRemoteParticipant = (ps: ConversationParticipant[]): boolean =>
  ps.some((p) => !!p.user_id || (!!p.email && p.email.includes('@')));

/**
 * Create-or-resume a conversation and send the first message.
 * ``draftRef`` (when provided) preserves the same Conversation id across
 * retries so a transient share() failure doesn't orphan a hub conversation.
 */
export async function createAndSendConversation(
  params: CreateAndSendParams,
  payload: ConversationSendPayload,
  opts?: {
    ensureCloudLogin?: () => Promise<{ ok: true } | { ok: false; error: string }>;
    draftRef?: { current: Conversation | null };
  },
): Promise<CreateAndSendResult> {
  let conversationId: string;

  if (hasRemoteParticipant(params.participants)) {
    if (opts?.ensureCloudLogin) {
      const gate = await opts.ensureCloudLogin();
      if (!gate.ok) throw new Error(gate.error);
    }
    const emails = params.participants
      .map((p) => (p.email || '').trim())
      .filter((e): e is string => !!e && e.includes('@'));
    if (emails.length === 0) {
      throw new Error('At least one recipient email is required');
    }

    const conv =
      opts?.draftRef?.current ??
      new Conversation({ title: params.title, participants: params.participants });
    if (params.title !== undefined) conv.title = params.title;
    conv.participants = params.participants;
    if (opts?.draftRef) opts.draftRef.current = conv;

    await conv.save();
    await conv.share(emails);
    conversationId = conv.id;
  } else {
    if (!params.project_id) {
      throw new Error('project_id is required for project-local conversations');
    }
    const r = await createProjectConversation({
      project_id: params.project_id,
      participants: params.participants,
      title: params.title,
    });
    conversationId = r.conversation_id;
  }

  await sendToExistingConversation(conversationId, payload);

  if (opts?.draftRef) opts.draftRef.current = null;
  return { conversation_id: conversationId };
}
