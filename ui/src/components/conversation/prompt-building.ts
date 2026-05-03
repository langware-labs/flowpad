import { dataManager, FlowMessage, TypeId } from '@sdk';
import { ActionInfo } from '@sdk/models/ActionInfo';
import { AttachmentType } from '@sdk/entities/flow-message';

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
 * file's contents follow under a labelled section. Lets a "type some prompt
 * + drop a file" reply run as a single Claude turn instead of N sequential
 * ones.
 */
export async function buildMergedPrompt(flowMessage: FlowMessage): Promise<string> {
  const promptAtts = (flowMessage.attachment ?? []).filter(
    (a) => a.attachment_type === AttachmentType.PROMPT,
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

  return [...inlineParts, ...filePromptParts].join('\n\n');
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
