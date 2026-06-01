import { ActionInfo } from '@sdk/models/ActionInfo';
import { attachmentDataString, type Attachment } from '@sdk/entities/flow-message';

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
