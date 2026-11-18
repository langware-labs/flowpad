import { dataManager, FlowMessage, fsManager, QueryFilter, QueryRequest, TypeId, type AssetDescriptor } from '@sdk';
import { ActionInfo } from '@sdk/models/ActionInfo';
import { AttachmentType, attachmentDataString } from '@sdk/entities/flow-message';

/** URL pointing at the local-only `.flowmsg` zip download for `messageId`. */
export { localFlowMessageBundleUrl as localBundleUrl } from '@sdk';

/** A request that outlives its page may carry 64 KiB in all; a character is up to 4 bytes. */
const KEEPALIVE_MAX_CHARS = 8000;

/** Where an uploaded file sits inside its message — the backend's `FILE_VFS_PREFIX`. */
const FILE_PREFIX = 'data/';

/** What a composer holds before it is sent: the whole message, and the choices made for its send. */
export interface ComposerDraft {
  text: string;
  files: File[];
  assetRefs: AssetDescriptor[];
  replyToId: string | null;
  taskIt: boolean;
  promptCall: boolean;
}

/** Which composer a draft belongs to: a conversation's own, or one of its threads'. */
export interface ComposerDraftKey {
  conversationId: string;
  threadId?: string | null;
  /** A native thread's root message: the draft is sent into that thread. */
  threadRootId?: string | null;
}

export const isEmptyDraft = (d: ComposerDraft) => !d.text.trim() && d.files.length === 0 && d.assetRefs.length === 0;

const fileNamesOf = (fm: FlowMessage) =>
  (fm.attachment ?? [])
    .filter((a) => a.attachment_type === AttachmentType.FILE)
    .map((a) => attachmentDataString(a).slice(FILE_PREFIX.length));

/** The assets a draft carries: its TYPE_ID attachments, less its own two pointers (the backend's
 *  `FlowMessage.asset_typeids`) — another conversation or message it names is an asset like any. */
const assetTypeIdsOf = (fm: FlowMessage) =>
  (fm.attachment ?? [])
    .filter((a) => a.attachment_type === AttachmentType.TYPE_ID)
    .map((a) => attachmentDataString(a))
    .filter((id) => id !== `conversation-${fm.conversation_id}` && id !== `flow_message-${fm.id}`);

/** The draft row of one composer — at most one. A reply held for review is its session's, not a composer's. */
async function findComposerDraft(key: ComposerDraftKey): Promise<FlowMessage | null> {
  const rows = await dataManager.query<FlowMessage>(
    new QueryRequest({
      type: FlowMessage.type,
      scope: [],
      name: `composer-draft:${key.conversationId}`,
      query: new QueryFilter({
        match: {
          op: '$AND',
          operands: [
            { op: '$EQ', operands: ['conversation_id', key.conversationId] },
            { op: '$EQ', operands: ['delivery_status', 'draft'] },
          ],
        } as Record<string, unknown>,
      }),
    }),
    true,
  );
  return (
    rows.find((fm) => !fm.remote_worker_session_id && (fm.draft_options?.thread_id ?? null) === (key.threadId ?? null)) ??
    null
  );
}

/** A stored draft as the composer holds it: its files come back as the bytes that were attached. */
export async function loadComposerDraft(key: ComposerDraftKey): Promise<{ row: FlowMessage; draft: ComposerDraft } | null> {
  const row = await findComposerDraft(key);
  if (!row?.id) return null;
  const typeId = new TypeId(FlowMessage.type, row.id);
  const files = await Promise.all(
    fileNamesOf(row).map(async (name) => {
      const blob = (await fsManager.download(typeId, `${FILE_PREFIX}${name}`, { asBlob: true })) as Blob;
      return new File([blob], name, { type: blob.type });
    }),
  );
  return {
    row,
    draft: {
      text: row.text ?? '',
      files,
      // A chip reads its label from the entity cache by typeid; nothing else of the descriptor is sent.
      assetRefs: assetTypeIdsOf(row).map((typeid) => ({ typeid, source: 'project_dir', posix_path: null })),
      replyToId: row.reply_to_id ?? null,
      taskIt: !!row.draft_options?.task,
      promptCall: !!row.draft_options?.call,
    },
  };
}

/**
 * Make the stored draft what the composer holds now — the one writer of a composer's draft.
 * `stored` are the files the row already has: only new ones are uploaded, and one no longer held is
 * dropped. An empty draft is deleted. Answers the row, or null when nothing is kept.
 */
export async function putComposerDraft(
  key: ComposerDraftKey,
  draft: ComposerDraft,
  stored: ReadonlySet<File>,
): Promise<FlowMessage | null> {
  const action = new ActionInfo('draft', 'conversation', key.conversationId, 'POST');
  const fresh = draft.files.filter((f) => !stored.has(f));
  const fields: Record<string, string> = {
    text: draft.text,
    thread_id: key.threadId ?? '',
    thread_root_id: key.threadRootId ?? '',
    reply_to_id: draft.replyToId ?? '',
    asset_references: JSON.stringify(draft.assetRefs.map((a) => a.typeid)),
    file_names: JSON.stringify(draft.files.filter((f) => stored.has(f)).map((f) => f.name)),
    task: String(draft.taskIt),
    call: String(draft.promptCall),
  };
  if (fresh.length > 0) {
    // Multipart: binary bodies only travel over REST.
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) form.append(name, value);
    for (const file of fresh) form.append('files', file, file.name);
    action.bodyParameters = form;
  } else {
    action.bodyParameters = fields;
    // A window that closes mid-typing still delivers its last save. The browser carries only a
    // small body past the page's end, so a long text goes the ordinary way.
    action.keepalive = draft.text.length < KEEPALIVE_MAX_CHARS;
  }
  const res = await dataManager.callAction<unknown, { draft: Record<string, unknown> | null }>(action);
  return res?.draft ? new FlowMessage(res.draft) : null;
}
