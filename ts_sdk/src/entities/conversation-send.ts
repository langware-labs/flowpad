import { dataManager } from '../APIEntity';
import { ActionInfo } from '../models/ActionInfo';
import { sendReply } from './notifications';
import {
  Conversation,
  ConversationParticipant,
  createProjectConversation,
} from './conversation';
import { FlowMessage } from './flow-message';

/**
 * Unified send payload. ``text`` may be empty when ``assetReferences`` or
 * ``files`` carry the meaning (e.g. share-a-doc with no commentary).
 */
export interface ConversationSendPayload {
  text: string;
  files?: File[];
  /** Serialized TypeIds (e.g. ``"markdown-<uuid>"``) for TYPE_ID attachments. */
  assetReferences?: string[];
  /** Serialized TypeIds to publish as the FlowMessage's *shared* context. On
   *  the existing-conversation path the local backend (handle_add_message)
   *  also merges these onto the parent Conversation and links them back —
   *  parity with the new-conversation path, without minting a new invite. */
  sharedContextEntities?: string[];
}

/** Send into an already-existing conversation. Thin wrap over ``sendReply`` —
 *  NEVER calls ``conv.share()``, so it can never mint a new invitation. */
export async function sendToExistingConversation(
  conversationId: string,
  payload: ConversationSendPayload,
): Promise<void> {
  const hasAssetRefs = !!payload.assetReferences?.length;
  const hasSharedCtx = !!payload.sharedContextEntities?.length;
  await sendReply(
    { conversationId },
    payload.text,
    payload.files,
    hasAssetRefs || hasSharedCtx
      ? {
          ...(hasAssetRefs ? { assetReferences: payload.assetReferences } : {}),
          ...(hasSharedCtx ? { sharedContextEntities: payload.sharedContextEntities } : {}),
        }
      : undefined,
  );
}

/** Source of a flow-diagnose report's body. */
export interface DiagnosisReportSource {
  /** The recorded support FlowMessage — its `text` is the full, already-formatted
   *  diagnostic report (sections + newlines), the single source of truth. */
  flowMessageId?: string | null;
  /** Plain summary used only when there's no support FlowMessage to read. */
  fallbackText?: string;
}

/**
 * Send a flow-diagnose report into a conversation and un-hide it. Shared by the
 * Home-Feed card's "Report issue" / "Forward" actions and the UI diagnose modal's
 * report buttons.
 *
 * The body is the recorded support FlowMessage's `text` — the full, nicely
 * formatted diagnostic report with its section breaks and newlines — NOT the
 * one-line summary (which rendered as an unreadable wall of text). When the
 * target *is* the support conversation (the "Report issue" path), that report
 * message already lives there, so we don't re-send and duplicate it — we just
 * clear `dismissed_at` so the existing conversation surfaces in the Recent strip.
 * A "Forward" to a different conversation does send the formatted body across.
 *
 * Callers do their own follow-up (the Feed dismisses its entry; the modal closes).
 */
export async function sendDiagnosisReport(
  conversationId: string,
  source: DiagnosisReportSource,
): Promise<void> {
  let text = source.fallbackText ?? '';
  let sourceConversationId: string | null = null;
  if (source.flowMessageId) {
    const msg = await FlowMessage.getById<FlowMessage>(source.flowMessageId);
    if (msg?.text) {
      text = msg.text;
      sourceConversationId = msg.conversation_id ?? null;
    }
  }
  // Only post when forwarding to a *different* conversation — sending the report
  // back into the conversation that already holds it would just duplicate it.
  if (text && sourceConversationId !== conversationId) {
    await sendToExistingConversation(conversationId, { text });
  }
  const conv = await Conversation.getById<Conversation>(conversationId);
  if (!conv) return;
  conv.dismissed_at = null;
  conv.updated_date = new Date().toISOString();
  await conv.save([]);
}

/**
 * Email a diagnosis to the Flowpad team. Calls the backend ``report`` action
 * (``POST /api/v1/graph/report``), which gathers the diagnosis's interesting
 * parts (what happened, the user's own words, who/when/which OS) and relays them
 * to the hub — the hub holds the SendGrid key and sends to diagnosis@langware.ai.
 * Used by the Home-Feed card's and the diagnose modal's "Report issue" button.
 */
export async function sendDiagnosisEmailReport(diagnosisId: string): Promise<void> {
  // Null-entity graph service action → POST /api/v1/graph/report.
  const info = new ActionInfo('report', null, null, 'POST');
  info.bodyParameters = { diagnosis_id: diagnosisId };
  await dataManager.callAction<{ diagnosis_id: string }, { sent: boolean }>(info);
}

export interface CreateAndSendParams {
  /** Required for project-local conversations; null for cross-user bundle. */
  project_id?: string | null;
  participants: ConversationParticipant[];
  title?: string;
  /** Serialized TypeIds stamped as the new conversation's shared context at
   *  create time (constructor-lift into ``_shared_context_entities_``). */
  shared_context_entities?: string[];
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
 * Create-or-resume a conversation WITHOUT sending anything into it — the
 * create+share half of ``createAndSendConversation``, exposed for commits
 * that put their content in by another means (e.g. ``forwardMessage``).
 * ``draftRef`` (when provided) preserves the same Conversation id across
 * retries so a transient share() failure doesn't orphan a hub conversation.
 */
export async function createConversationForShare(
  params: CreateAndSendParams,
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
      new Conversation({
        title: params.title,
        participants: params.participants,
        // ``shared_context_entities`` is a wire-lifted field (not on IConversation);
        // the APIEntity base moves it into ``_shared_context_entities_`` on construct.
        ...(params.shared_context_entities && params.shared_context_entities.length > 0
          ? { shared_context_entities: params.shared_context_entities }
          : {}),
      } as Partial<Conversation>);
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
      // Let the backend derive the owning project from the shared entity
      // (deterministic), with ``project_id`` as the ambient fallback.
      shared_context_entities: params.shared_context_entities,
    });
    conversationId = r.conversation_id;
  }

  return { conversation_id: conversationId };
}

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
  const { conversation_id: conversationId } = await createConversationForShare(params, opts);

  await sendToExistingConversation(conversationId, payload);

  if (opts?.draftRef) opts.draftRef.current = null;
  return { conversation_id: conversationId };
}
