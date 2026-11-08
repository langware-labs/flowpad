import { useCallback, useEffect, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { LifeBuoy } from 'lucide-react';
import { type HelpContextItem, helpRequestContext, helpRequestShare } from '@sdk';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';
import { ContentReviewDialog } from './asset-review/ContentReviewDialog';

/**
 * Under a help request: what it is, and -- on the asker's side, while its context waits on this computer --
 * the one line "Context: Not shared → Share | Open". Open is the message review (``ContentReviewDialog``);
 * Share sends the request (when it was kept here) and its context, minus what was left out.
 */
export function HelpRequestLine({ conversationId, isMine }: { conversationId: string; isMine: boolean }) {
  const { t } = useLingui();
  const [held, setHeld] = useState<HelpContextItem[]>([]);
  const [leftOut, setLeftOut] = useState<string[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [sharing, setSharing] = useState(false);

  const load = useCallback(() => {
    if (!isMine || !conversationId) return;
    void helpRequestContext(conversationId)
      .then(setHeld)
      .catch(() => setHeld([]));
  }, [conversationId, isMine]);
  useEffect(load, [load]);

  const share = async () => {
    setSharing(true);
    try {
      await helpRequestShare(conversationId, leftOut);
      setHeld([]);
    } catch (e: unknown) {
      notify.error({ title: t`Could not share`, message: errorMessage(e, ''), forceToast: true });
    } finally {
      setSharing(false);
    }
  };

  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground" data-testid="help-request-line">
      <span className="flex items-center gap-1 rounded-full border px-2 py-0.5" data-testid="help-request-chip">
        <LifeBuoy className="h-3 w-3" />
        {t`Help request`}
      </span>
      {held.length > 0 && (
        <span className="flex items-center gap-2" data-testid="help-request-not-shared">
          {t`Context:`}
          <span className="rounded-full border px-2 py-0.5">{t`Not shared`}</span>
          <button
            type="button"
            className="rounded-full border border-primary bg-primary/10 px-2.5 py-0.5 text-foreground"
            onClick={() => void share()}
            disabled={sharing}
            data-testid="help-request-share"
          >
            {sharing ? t`Sharing…` : t`Share`}
          </button>
          <span>|</span>
          <button
            type="button"
            className="rounded-full border px-2.5 py-0.5"
            onClick={() => setReviewOpen(true)}
            data-testid="help-request-open"
          >
            {t`Open`}
          </button>
        </span>
      )}
      {reviewOpen && (
        <ContentReviewDialog
          open={reviewOpen}
          onClose={() => setReviewOpen(false)}
          items={held}
          leftOut={leftOut}
          onLeftOutChange={setLeftOut}
          onShare={() => void share()}
        />
      )}
    </div>
  );
}
