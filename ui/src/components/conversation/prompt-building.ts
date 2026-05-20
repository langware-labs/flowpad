import { dataManager, FlowMessage, TypeId } from '@sdk';
import { ActionInfo } from '@sdk/models/ActionInfo';
import { AttachmentType } from '@sdk/entities/flow-message';
import { fileAttachmentUrl } from './attachment-url';

/** Title-case the type slug for human-friendly type labels. */
function humanType(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1).replace(/_/g, ' ');
}

/**
 * Build the "context entities saved locally" lines for a list of TypeIds.
 *
 * Every Flowpad entity is mirrored on disk under `recordsRoot` as the folder
 * `<type>/<type>-@<id>/`; Claude can `Read` any file inside it (metadata.json,
 * data/*.json, the asset). When `recordsRoot` is unset (rare — server
 * bootstrap hasn't run yet) we fall back to the GET endpoint so the lines
 * still resolve to *something* readable.
 *
 * Format per line: `- <TypeName>: <type>/<id>, read: <folder-path>`. Caller is
 * expected to dedupe TypeIds before passing them in.
 */
export function buildContextEntityLines(typeIds: readonly TypeId[]): string[] {
  const recordsRoot = dataManager.recordsRoot;
  const out: string[] = [];
  for (const tid of typeIds) {
    if (!tid?.type || !tid?.id || tid.type === FlowMessage.type) continue;
    const label = humanType(tid.type);
    if (recordsRoot) {
      const recordPath = `${recordsRoot}/${tid.type}/${tid.type}-@${tid.id}`;
      out.push(`- ${label}: ${tid.toUrlString()}, read: ${recordPath}`);
    } else {
      out.push(`- ${label}: ${tid.toUrlString()}, fetch: GET http://localhost:9007/api/v1/graph/${tid.type}/${tid.id}`);
    }
  }
  return out;
}

/**
 * Format the conversation's context as two labelled groups — "Shared" (what
 * every participant can see on the message) and "Private" (what the local
 * user has attached for themselves under Private Context).
 *
 * Returned as a single newline-joined block; empty groups are skipped so a
 * conversation with no private items doesn't emit a dangling header.
 */
export function buildSharedAndPrivateContextSection(
  sharedTypeIds: readonly TypeId[],
  privateTypeIds: readonly TypeId[],
): string {
  const parts: string[] = [];
  const sharedLines = buildContextEntityLines(sharedTypeIds);
  if (sharedLines.length > 0) {
    parts.push('Shared context (visible to every participant in this conversation):');
    parts.push(...sharedLines);
  }
  const privateLines = buildContextEntityLines(privateTypeIds);
  if (privateLines.length > 0) {
    if (parts.length > 0) parts.push('');
    parts.push('Private context (visible only to you):');
    parts.push(...privateLines);
  }
  return parts.join('\n');
}

/**
 * Build the instruction injected when the user clicks "Use Flowpad assistance"
 * below the Private Context table. The session has no concrete task yet — it
 * just exposes the available shared/private entities so Claude can answer
 * questions from any participant.
 */
export function buildAssistancePrompt(
  sharedTypeIds: readonly TypeId[],
  privateTypeIds: readonly TypeId[],
): string {
  const ctx = buildSharedAndPrivateContextSection(sharedTypeIds, privateTypeIds);
  const intro =
    'Use Flowpad Assistant to help answer questions from the user. ' +
    'Read each referenced entity folder to ground your answers in the actual entity contents.';
  return ctx ? `${intro}\n\n${ctx}` : intro;
}

/**
 * Resolve a single PROMPT attachment to its inline text.
 *
 * - Inline text → return `data` verbatim.
 * - File-backed (`prompt/<filename>`) → fetch via `local_path`. Falls back to
 *   a placeholder string if the fetch fails so the prompt stays runnable.
 */
export async function resolvePromptText(
  att: { data: string; local_path?: string | null },
): Promise<string> {
  if (att.data && att.data.startsWith('prompt/') && att.local_path) {
    try {
      const res = await fetch(att.local_path);
      if (res.ok) return await res.text();
    } catch {
      // fall through
    }
    return `(Attached prompt file: ${att.data})`;
  }
  return att.data ?? '';
}

/**
 * Merge every PROMPT and FILE attachment on a message into a single instruction.
 *
 * - Inline PROMPT text (typed in the dialog) is concatenated as-is.
 * - File-backed PROMPT attachments (`data` starts with `prompt/`) are referenced
 *   by their absolute local path: `Your prompt to execute is here: <path>`.
 *   The agent reads the file directly instead of us inlining it (works for
 *   binaries; avoids context bloat for large text files).
 * - FILE attachments are listed at the end as absolute paths the agent can read.
 *
 * For hub-mirrored conversations the bytes live on the hub until first access;
 * we pre-fetch every file-backed attachment via ``fileAttachmentUrl`` (the local
 * download endpoint with hub fallback) so the cached copy lands on local disk
 * before the agent tries to read the path.
 */
export async function buildMergedPrompt(flowMessage: FlowMessage): Promise<string> {
  const promptAtts = (flowMessage.attachment ?? []).filter(
    (a) => a.attachment_type === AttachmentType.PROMPT,
  );
  const fileAtts = (flowMessage.attachment ?? []).filter(
    (a) => a.attachment_type === AttachmentType.FILE && !!a.data && !a.data.endsWith('conversation.jsonl'),
  );

  const inlineParts: string[] = [];
  const promptFilePaths: string[] = [];

  for (const att of promptAtts) {
    const isFile = !!att.data && att.data.startsWith('prompt/');
    if (isFile && flowMessage.id) {
      // Trigger the local download endpoint so a hub-mirrored FlowMessage's
      // bytes are cached on disk before the agent reads via local_path.
      try {
        await fetch(fileAttachmentUrl(flowMessage.id, att.data));
      } catch {
        // best-effort
      }
      const localPath = att.local_path || att.data;
      promptFilePaths.push(`Your prompt to execute is here: ${localPath}`);
    } else {
      const text = await resolvePromptText(att);
      if (text) inlineParts.push(text);
    }
  }

  const fileContext: string[] = [];
  if (fileAtts.length > 0 && flowMessage.id) {
    const lines: string[] = [];
    for (const att of fileAtts) {
      try {
        await fetch(fileAttachmentUrl(flowMessage.id, att.data));
      } catch {
        // best-effort
      }
      const localPath = att.local_path || att.data;
      const filename = att.data.split('/').pop() ?? att.data;
      lines.push(`- ${filename}: ${localPath}`);
    }
    fileContext.push(
      `The user attached the following files as context — use them when answering:\n${lines.join('\n')}`,
    );
  }

  // Prompt sends the wire-bound (shared) context — same data any other
  // reader of this FlowMessage would see. Private (local-only) context is
  // not propagated to the model.
  const contextLines = buildContextEntityLines(flowMessage.sharedContextEntities);
  const contextSection: string[] = [];
  if (contextLines.length > 0) {
    contextSection.push(
      `See context below. Use Flowpad Assistant to read it and read each referenced entity folder to ground your answers in the actual entity contents.\n${contextLines.join('\n')}`,
    );
  }

  return [...inlineParts, ...promptFilePaths, ...fileContext, ...contextSection].join('\n\n');
}

/** POST `approve-prompt`, then refetch the FlowMessage and nudge cache subscribers
 * so the approve-and-execute button re-evaluates immediately — don't wait for the
 * backend's WS UPDATE round-trip (which has been observed to land late or miss
 * `useEntity` consumers, leaving the button visible after a successful approve).
 *
 * `invalidateCacheByTypeId` drops the stale entry so `getByTypeId` re-fetches
 * from the server (with the new `approved_by` populated and `local_path`
 * resolved); `notifyEntityChanged` then ticks every watched query for the
 * `flow_message` type so React subscribers re-render against the fresh data.
 */
export async function approveAndReload(messageId: string, attachmentIndex: number): Promise<FlowMessage | null> {
  const approveAction = new ActionInfo('approve-prompt', 'flow_message', messageId, 'POST');
  approveAction.bodyParameters = { attachment_index: attachmentIndex, approve_all: true };
  await dataManager.callAction(approveAction);

  const typeId = new TypeId(FlowMessage.type, messageId);
  dataManager.invalidateCacheByTypeId(typeId);
  const fm = await dataManager.getByTypeId<FlowMessage>(typeId).catch(() => null);
  if (fm) {
    dataManager.notifyEntityChanged(fm);
  }
  return fm;
}
