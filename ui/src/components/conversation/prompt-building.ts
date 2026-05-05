import { dataManager, FlowMessage, TypeId } from '@sdk';
import { ActionInfo } from '@sdk/models/ActionInfo';
import { AttachmentType } from '@sdk/entities/flow-message';
import { fileAttachmentUrl } from './attachment-url';

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

  return [...inlineParts, ...promptFilePaths, ...fileContext].join('\n\n');
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
