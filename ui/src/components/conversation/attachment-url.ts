import { ActionInfo } from '@sdk/models/ActionInfo';

/**
 * Build the GET URL that streams a single FILE / PROMPT-file attachment from
 * a FlowMessage's embedded VFS storage. `vfsPath` is the attachment's `data`
 * field (e.g. `data/foo.txt` or `prompt/bar.md`) — i.e. the path *inside*
 * the entity's storage root, not an absolute filesystem path.
 *
 * Centralised here so the conversation UI never builds this URL by hand.
 */
export function fileAttachmentUrl(messageId: string, vfsPath: string): string {
  const action = new ActionInfo('fs', 'flow_message', messageId, 'GET');
  action.subpath = `download/${vfsPath}`;
  return action.fullActionUrl;
}
