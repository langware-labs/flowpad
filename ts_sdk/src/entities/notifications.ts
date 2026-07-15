import { dataManager } from '../APIEntity';
import { ActionInfo } from '../models/ActionInfo';

export interface SendReplyExtras {
  /** Inline prompt text to attach as a PROMPT attachment. */
  promptText?: string;
  /** Files to attach as PROMPT attachments (each stored under prompt/<filename>). */
  promptFiles?: File[];
  /** TypeId strings (e.g. "skill-<uuid>") to attach as TYPE_ID attachments. */
  assetReferences?: string[];
  /** Additional TypeId strings to publish in the FlowMessage's *shared*
   *  context (deduped against the conversation TypeIds already stamped by
   *  the backend). The wire field is ``shared_context_entities``. */
  sharedContextEntities?: string[];
  /** Transfer policy + per-share opt-ins for body-bundle attachments. */
  shareConfig?: {
    transferMode?: 'copy' | 'git';
    /** Mint a FAVORITE bookmark on the receiver at install. Default off. */
    createBookmark?: boolean;
  };
  /** Live-session grouping key. The backend stamps it on the FlowMessage and
   *  auto-appends the authoritative `remote_worker_session-<id>` TYPE_ID
   *  carrier attachment (the hub drops unknown header fields). */
  remoteWorkerSessionId?: string;
}

/** Serialize shareConfig to the backend's snake_case share_config shape.
 *  Kept in one place so the multipart and JSON send paths agree. */
function serializeShareConfig(cfg: SendReplyExtras['shareConfig']): Record<string, unknown> {
  return {
    transfer_mode: cfg?.transferMode ?? 'copy',
    ...(cfg?.createBookmark ? { create_bookmark: true } : {}),
  };
}

export interface SendReplyTarget {
  /** Conversation to append to. */
  conversationId: string;
}

export async function sendReply(
  target: SendReplyTarget,
  message: string,
  files?: File[],
  extras?: SendReplyExtras,
): Promise<void> {
  const conversationId = target?.conversationId ?? null;
  if (!conversationId) {
    throw new Error('sendReply requires a conversationId');
  }

  // Single send endpoint: conversation/<id>/add_message. The conversation id
  // rides in the URL — the local backend (handle_add_message) reads it there.
  const action = new ActionInfo('add_message', 'conversation', conversationId, 'POST');
  const hasAssetRefs = !!(extras?.assetReferences && extras.assetReferences.length > 0);
  const hasFiles =
    (files && files.length > 0) ||
    (extras?.promptFiles && extras.promptFiles.length > 0) ||
    hasAssetRefs;
  const sharedCtxEntities = (extras?.sharedContextEntities ?? []).filter(Boolean);
  if (hasFiles) {
    const form = new FormData();
    form.append('message', message);
    if (extras?.promptText) form.append('prompt_text', extras.promptText);
    for (const file of files ?? []) {
      form.append('files', file, file.name);
    }
    for (const file of extras?.promptFiles ?? []) {
      form.append('prompt_files', file, file.name);
    }
    if (hasAssetRefs) {
      form.append('asset_references', JSON.stringify(extras!.assetReferences));
    }
    if (extras?.shareConfig) {
      form.append('share_config', JSON.stringify(serializeShareConfig(extras.shareConfig)));
    }
    for (const ce of sharedCtxEntities) {
      form.append('shared_context_entities', ce);
    }
    if (extras?.remoteWorkerSessionId) {
      form.append('remote_worker_session_id', extras.remoteWorkerSessionId);
    }
    action.bodyParameters = form;
    // File sends are multipart — binary bodies only travel over REST.
    await dataManager.callAction(action);
  } else {
    const body: Record<string, unknown> = { message };
    if (extras?.promptText) body.prompt_text = extras.promptText;
    if (sharedCtxEntities.length > 0) body.shared_context_entities = sharedCtxEntities;
    if (extras?.shareConfig) body.share_config = serializeShareConfig(extras.shareConfig);
    if (extras?.remoteWorkerSessionId) body.remote_worker_session_id = extras.remoteWorkerSessionId;
    action.bodyParameters = body;
    // Text-only send: prefer the WebSocket hop when the socket is open
    // (skips an HTTP round-trip), fall back to REST otherwise.
    await dataManager.callActionPreferWS(action);
  }
}

export async function refreshNotifications(projectPath?: string): Promise<void> {
  const action = new ActionInfo('refresh', 'notification', null, 'POST');
  action.bodyParameters = { project_path: projectPath ?? '' };
  await dataManager.callAction(action);
}
