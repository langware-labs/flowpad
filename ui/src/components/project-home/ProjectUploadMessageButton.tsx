import { useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Loader2, Upload } from 'lucide-react';
import { uploadFlowMessage } from '@sdk';
import { AssetReviewDialog } from '@src/components/conversation/asset-review/AssetReviewDialog';
import { useFlowMessageAttachments } from '@src/components/conversation/useMessageAttachments';
import { Button } from '@src/components/ui/button';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';
import { useUiActionRequest } from '@src/navigation/ui-actions';

export interface UploadedMessage {
  messageId: string;
  /** Selected first in the review rail. */
  firstAttachmentId: string;
}

/** The review of an uploaded message that has no conversation to open: what it
 *  carries, with ``projectId`` as the install target. */
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

interface ProjectUploadMessageButtonProps {
  projectId: string;
}

/**
 * Upload a `.flowmsg` someone handed over, then review what it carries with THIS
 * project as the install target. Nothing goes live at upload — the review
 * dialog's install is the consent step, exactly as for a message received in a
 * conversation.
 */
export function ProjectUploadMessageButton({ projectId }: ProjectUploadMessageButtonProps) {
  const { t } = useLingui();
  const inputRef = useRef<HTMLInputElement>(null);
  // "upload a message" (smart navigation): the same file picker the button opens.
  useUiActionRequest(['upload-flowmsg'], () => inputRef.current?.click());
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<UploadedMessage | null>(null);

  const upload = async (file: File) => {
    setBusy(true);
    try {
      // Uploading the same file again re-stages the same message: overwrite is
      // the reviewable re-open, not a clobber (install state lives on the rows).
      const result = await uploadFlowMessage(file, { overwrite: true });
      const staged = result.attachments ?? [];
      if (staged.length === 0) {
        notify.info({ title: t`Nothing to install`, message: t`This message carries no assets.` });
        return;
      }
      setReview({ messageId: result.message_id, firstAttachmentId: staged[0].id });
    } catch (err: unknown) {
      notify.error({ title: t`Upload failed`, message: errorMessage(err, t`Could not upload this message.`) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".flowmsg"
        className="hidden"
        data-testid="project-upload-message-input"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void upload(file);
        }}
      />
      <Button
        variant="outline"
        size="sm"
        className="h-7 gap-1.5 px-2 text-xs"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        title={t`Upload a .flowmsg and install what it carries into this project`}
        data-testid="project-upload-message"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
        {t`Upload message`}
      </Button>
      {review && <UploadedMessageReview {...review} projectId={projectId} onClose={() => setReview(null)} />}
    </>
  );
}
