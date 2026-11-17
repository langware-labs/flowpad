import { useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Loader2, Upload } from 'lucide-react';
import { uploadFlowMessage } from '@sdk';
import { useStagedMessageReview } from '@src/components/conversation/StagedMessageReview';
import { Button, type ButtonProps } from '@src/components/ui/button';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';
import { useUiActionRequest } from '@src/navigation/ui-actions';

/**
 * Upload a `.flowmsg` someone handed over, then review what it carries (no
 * project preset as the install target). Nothing goes live at upload — the review
 * dialog's install is the consent step, exactly as for a message received in a
 * conversation.
 */
export function ProjectUploadMessageButton({
  variant = 'ghost',
  size = 'sm',
}: Pick<ButtonProps, 'variant' | 'size'> = {}) {
  const { t } = useLingui();
  const inputRef = useRef<HTMLInputElement>(null);
  // "upload a message" (smart navigation): the same file picker the button opens.
  useUiActionRequest(['upload-flowmsg'], () => inputRef.current?.click());
  const [busy, setBusy] = useState(false);
  const review = useStagedMessageReview(null);

  const upload = async (file: File) => {
    setBusy(true);
    try {
      // Uploading the same file again re-stages the same message: overwrite is
      // the reviewable re-open, not a clobber (install state lives on the rows).
      const result = await uploadFlowMessage(file, { overwrite: true });
      review.open(result);
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
        variant={variant}
        size={size}
        className={size === 'sm' ? 'h-7 text-xs' : undefined}
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        title={t`Open a .flowmsg and install what it carries`}
        data-testid="project-upload-message"
      >
        {busy ? <Loader2 className="me-1 h-3.5 w-3.5 animate-spin" /> : <Upload className="me-1 h-3.5 w-3.5" />}
        {t`Open`}
      </Button>
      {review.dialog}
    </>
  );
}
