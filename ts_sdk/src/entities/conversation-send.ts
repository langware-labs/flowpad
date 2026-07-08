import { dataManager } from '../APIEntity';
import { ActionInfo } from '../models/ActionInfo';
import { normalizeEmail } from '../utils/utils';
import { sendReply } from './notifications';
import {
  Conversation,
  ConversationParticipant,
  createProjectConversation,
} from './conversation';
import { FlowpadDiagnosis } from './flowpad-diagnosis';

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
  /** Body-bundle transfer policy. Defaults to copy. */
  shareConfig?: {
    transferMode?: 'copy' | 'git';
  };
}

/** Send into an already-existing conversation. Thin wrap over ``sendReply`` —
 *  NEVER calls ``conv.share()``, so it can never mint a new invitation. */
export async function sendToExistingConversation(
  conversationId: string,
  payload: ConversationSendPayload,
): Promise<void> {
  const hasAssetRefs = !!payload.assetReferences?.length;
  const hasSharedCtx = !!payload.sharedContextEntities?.length;
  const extras = {
    ...(hasAssetRefs ? { assetReferences: payload.assetReferences } : {}),
    ...(hasSharedCtx ? { sharedContextEntities: payload.sharedContextEntities } : {}),
    ...(payload.shareConfig ? { shareConfig: payload.shareConfig } : {}),
  };
  await sendReply(
    { conversationId },
    payload.text,
    payload.files,
    hasAssetRefs || hasSharedCtx || !!payload.shareConfig ? extras : undefined,
  );
}

/**
 * Forward a diagnosis into a conversation by **attaching the FlowpadDiagnosis
 * entity** (a TYPE_ID attachment) — not by pasting its full text. It renders as
 * an entity chip; clicking the chip opens the diagnosis viewer (`buildDockPointer`
 * → `DockPointer.forDiagnosis`). A short `Diagnosis: <title>` caption rides along
 * so the message is never blank before the chip materializes (the chip needs the
 * entity resolved locally; the caption is plain text and shows immediately).
 *
 * No explicit un-hide: appending this message already auto-revives a dismissed
 * conversation in the Recent strip (the strip hides a row only UNTIL a newer
 * FlowMessage lands). A manual `conv.save()` would be a full conversation update,
 * which the hub forbids for `member`-role participants — a needless 401.
 *
 * Shared by every "Forward" surface — the Home-Feed card, the diagnosis viewer/
 * popup, the live diagnose modal, and the System Diagnoses table. Callers do
 * their own follow-up (e.g. the modal closes).
 */
export async function forwardDiagnosis(
  conversationId: string,
  diagnosisId: string,
): Promise<void> {
  const diag = await FlowpadDiagnosis.getById<FlowpadDiagnosis>(diagnosisId);
  const title = diag?.title || diag?.name || 'Diagnosis';
  await sendToExistingConversation(conversationId, {
    text: `Diagnosis: ${title}`,
    assetReferences: [`${FlowpadDiagnosis.type}-${diagnosisId}`],
  });
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
      .map((p) => normalizeEmail(p.email) || '')
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
