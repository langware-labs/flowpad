import { ActionInfo } from '@sdk/models/ActionInfo';
import { AttachmentType, attachmentDataString, type Attachment } from '@sdk/entities/flow-message';
import { DockPointer } from '@src/navigation/DockPointer';
import { dockPointerForFile } from '@src/navigation/local-file-pointer';

/**
 * True for a FILE attachment the user can download as a chip — i.e. any FILE
 * except the `conversation.jsonl` transcript, which lives on the toolbar rather
 * than as an attachment chip. Shared so the bubble and the prompt builder agree
 * on what counts as a downloadable file.
 */
export function isDownloadableFileAttachment(
  att: Pick<Attachment, 'attachment_type' | 'data'>,
): boolean {
  if (att.attachment_type !== AttachmentType.FILE) return false;
  const d = attachmentDataString(att);
  return !!d && !d.endsWith('conversation.jsonl');
}

/**
 * Build the GET URL that streams a single FILE / PROMPT-file attachment from
 * a FlowMessage's embedded VFS storage. `vfsPath` is the attachment's `data`
 * field (e.g. `data/foo.txt` or `prompt/bar.md`) — i.e. the path *inside*
 * the entity's storage root, not an absolute filesystem path.
 *
 * Low-level builder: prefer `localAttachmentUrl` at call sites so the
 * "only when the bytes are local" rule is applied in one place.
 */
export function fileAttachmentUrl(messageId: string, vfsPath: string): string {
  const action = new ActionInfo('fs', 'flow_message', messageId, 'GET');
  action.subpath = `download/${vfsPath}`;
  return action.fullActionUrl;
}

/**
 * The stream URL for an attachment, or `null` when its bytes are NOT on local
 * disk yet (`local_path` unset). Returning null is the single rule that keeps
 * the UI from linking/fetching a body that was never downloaded — a dangling
 * pointer (`body_status='na'`) has no `local_path`, so it yields no URL instead
 * of a 404. To pull a not-yet-local body, go through `FlowMessage.downloadAttachments()`
 * (the chip's download affordance); this helper is only for already-local bytes.
 */
export function localAttachmentUrl(
  messageId: string,
  att: Pick<Attachment, 'data' | 'local_path'>,
): string | null {
  if (!att.local_path) return null;
  const vfsPath = attachmentDataString(att);
  if (!vfsPath) return null;
  return fileAttachmentUrl(messageId, vfsPath);
}

/**
 * Turn a downloaded attachment's absolute `local_path` into the VFS path the
 * editor opens. The file lives in the message's embedded storage (an absolute
 * path like `/tmp/.../data/SKILL.md`), NOT under any project root — so it must
 * be opened against the **@local** compute node. Prefixing with the
 * `compute_node-@local` TypeId makes `CodeEditor` resolve it via
 * `compute_node/@local/fs/download/<abs path>`; without the prefix the editor
 * falls back to the active project's root and 404s.
 */
export function editorPathForLocalFile(localPath: string): string {
  return `compute_node-@local/${localPath.replace(/^\/+/, '')}`;
}

/**
 * The dock pointer the conversation "Open" affordance navigates to for a
 * downloaded attachment. A markdown body opens in the **markdown document
 * editor** (the assets `editor/markdown` surface — rich Milkdown rendering with
 * working internal-link navigation), every other file in the code editor.
 * Both address the bytes against the **@local** compute node via
 * {@link editorPathForLocalFile}; the viewer dispatch is the shared
 * `dockPointerForFile` chokepoint.
 */
export function dockPointerForLocalFile(localPath: string): DockPointer {
  return dockPointerForFile(editorPathForLocalFile(localPath));
}
