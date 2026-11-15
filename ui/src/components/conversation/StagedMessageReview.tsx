import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { UploadFlowMessageResult } from '@sdk';
import { AssetReviewDialog } from '@src/components/conversation/asset-review/AssetReviewDialog';
import { useFlowMessageAttachments } from '@src/components/conversation/useMessageAttachments';
import { notify } from '@src/notifications';

export interface UploadedMessage {
  messageId: string;
  /** Selected first in the review rail. */
  firstAttachmentId: string;
}

/** The review of a staged message that has no conversation to open (an uploaded
 *  `.flowmsg`, or one received as a file): what it carries, with ``projectId``
 *  as the install target. */
export function UploadedMessageReview({
  messageId,
  firstAttachmentId,
  projectId,
  onClose,
}: UploadedMessage & { projectId: string | null; onClose: () => void }) {
  const attachments = useFlowMessageAttachments(messageId);
  if (attachments.length === 0) return null;
  return (
    <AssetReviewDialog
      open
      onClose={onClose}
      attachments={attachments}
      initialAttachmentId={firstAttachmentId}
      attachmentProjectId={projectId}
    />
  );
}

/** Open the review for what a staged `.flowmsg` carries — or say it carries nothing. */
export function useStagedMessageReview(projectId: string | null) {
  const { t } = useLingui();
  const [review, setReview] = useState<UploadedMessage | null>(null);
  const open = (result: UploadFlowMessageResult) => {
    const first = result.attachments?.[0];
    if (first) setReview({ messageId: result.message_id, firstAttachmentId: first.id });
    else notify.info({ title: t`Nothing to install`, message: t`This message carries no assets.` });
  };
  const dialog = review && <UploadedMessageReview {...review} projectId={projectId} onClose={() => setReview(null)} />;
  return { open, dialog };
}
