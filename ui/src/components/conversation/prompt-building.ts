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
 * Merge every PROMPT attachment on a message into a single instruction.
 * Inline text comes first (whatever the user typed in the dialog); each
 * file's contents follow under a labelled section, and any FILE attachments
 * (regular file uploads alongside the message) are listed at the end as
 * absolute paths the agent can read.
 *
 * For hub-mirrored conversations the FILE attachments live on the hub until
 * first access — we pre-fetch them via ``fileAttachmentUrl`` (the local
 * download endpoint with hub fallback) so the agent's path read resolves.
 */
export async function buildMergedPrompt(flowMessage: FlowMessage): Promise<string> {
  const promptAtts = (flowMessage.attachment ?? []).filter(
    (a) => a.attachment_type === AttachmentType.PROMPT,
  );
  const fileAtts = (flowMessage.attachment ?? []).filter(
    (a) => a.attachment_type === AttachmentType.FILE && !!a.data && !a.data.endsWith('conversation.jsonl'),
  );
  const inlineParts: string[] = [];
  const filePromptParts: string[] = [];

  for (const att of promptAtts) {
    const isFile = !!att.data && att.data.startsWith('prompt/');
    const text = await resolvePromptText(att);
    if (!text) continue;
    if (isFile) {
      const filename = att.data.split('/').pop() ?? att.data;
      filePromptParts.push(`--- ${filename} ---\n${text}`);
    } else {
      inlineParts.push(text);
    }
  }

  const fileContext: string[] = [];
  if (fileAtts.length > 0 && flowMessage.id) {
    // Pre-fetch each file so a hub-mirrored FlowMessage's bytes get cached
    // to local disk; the agent reads via local_path, which only resolves
    // once the local copy exists. Errors are non-fatal — we still tell the
    // agent the path, the read just fails downstream if the fetch flopped.
    const lines: string[] = [];
    for (const att of fileAtts) {
      const url = fileAttachmentUrl(flowMessage.id, att.data);
      try {
        await fetch(url);
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

  return [...inlineParts, ...filePromptParts, ...fileContext].join('\n\n');
}

/** POST `approve-prompt` and refetch the FlowMessage so PROMPT.local_path / approved_by are populated. */
export async function approveAndReload(messageId: string, attachmentIndex: number): Promise<FlowMessage | null> {
  const approveAction = new ActionInfo('approve-prompt', 'flow_message', messageId, 'POST');
  approveAction.bodyParameters = { attachment_index: attachmentIndex, approve_all: true };
  await dataManager.callAction(approveAction);
  return dataManager
    .getByTypeId<FlowMessage>(new TypeId(FlowMessage.type, messageId))
    .catch(() => null);
}
