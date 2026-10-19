import { Trans } from '@lingui/react/macro';
import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';

/**
 * The "why is this still going" line for a send in flight.
 *
 * A send is ONE awaited call from the dialog's point of view, but the backend
 * behind it does several slow things the user never sees: packing a body
 * bundle, summarizing an attached session transcript (the expensive one —
 * measured at ~45s for a share carrying 13 transcripts), pushing the header to
 * the hub, then uploading the bundle. With only a disabled button reading
 * "Sharing…", that window is indistinguishable from a hang, and the reasonable
 * reaction is to close the dialog or click again.
 *
 * We cannot show real phases — the backend reports no progress for this call —
 * so this deliberately does NOT invent them. It shows a spinner immediately and
 * escalates to an explanation once the wait has gone past what anyone would sit
 * through quietly.
 */
const EXPLAIN_AFTER_MS = 4000;

interface SendProgressNoticeProps {
  busy: boolean;
  /** Whether this send carries files / a transcript / an asset bundle — the
   *  slow cases. Lets the long-wait copy name the actual reason. */
  hasAttachments?: boolean;
}

export function SendProgressNotice({ busy, hasAttachments }: SendProgressNoticeProps) {
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (!busy) {
      setSlow(false);
      return;
    }
    const id = setTimeout(() => setSlow(true), EXPLAIN_AFTER_MS);
    return () => clearTimeout(id);
  }, [busy]);

  if (!busy) return null;

  return (
    <div
      className="flex items-start gap-2 text-xs text-muted-foreground"
      data-testid="send-progress-notice"
      role="status"
      aria-live="polite"
    >
      <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />
      <span>
        {!slow ? (
          <Trans>Sending…</Trans>
        ) : hasAttachments ? (
          <Trans>
            Still working — packing and uploading the attachments. A session transcript or large files can take a
            minute.
          </Trans>
        ) : (
          <Trans>Still working — waiting on the cloud. This can take a minute.</Trans>
        )}
      </span>
    </div>
  );
}
