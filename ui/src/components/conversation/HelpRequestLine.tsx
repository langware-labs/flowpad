import { useCallback, useEffect, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { LifeBuoy, Loader2 } from 'lucide-react';
import { type HelpContextItem, helpRequestDiagnosis, helpRequestHeld, helpRequestShare } from '@sdk';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';
import { ContentReviewDialog } from './asset-review/ContentReviewDialog';

/**
 * Under a help request: what it is; while its diagnosis runs, that it runs; and -- on the asker's side, while
 * its context waits on this computer -- "Context not shared · Share · Open". Open is the message review
 * (``ContentReviewDialog``); Share sends the request (when it was kept here) and its context, minus what was
 * left out. A private request (nobody asked yet: Diagnose & fix) has no Share -- its diagnosis offers Report it.
 */
export function HelpRequestLine({ conversationId, isMine }: { conversationId: string; isMine: boolean }) {
  const { t } = useLingui();
  const [held, setHeld] = useState<HelpContextItem[]>([]);
  const [leftOut, setLeftOut] = useState<string[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [isPrivate, setIsPrivate] = useState(false);
  const [diagnosing, setDiagnosing] = useState(false);

  const load = useCallback(() => {
    if (!isMine || !conversationId) return;
    void helpRequestHeld(conversationId)
      .then((h) => {
        setHeld(h.items);
        setIsPrivate(h.private);
      })
      .catch(() => setHeld([]));
    void helpRequestDiagnosis(conversationId)
      .then((d) => setDiagnosing(d.diagnosing))
      .catch(() => setDiagnosing(false));
  }, [conversationId, isMine]);
  useEffect(load, [load]);
  // The diagnosis lands as its own message; until it does, look again now and then.
  useEffect(() => {
    if (!diagnosing) return;
    const timer = window.setInterval(load, 3000);
    return () => window.clearInterval(timer);
  }, [diagnosing, load]);

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
      {diagnosing && (
        <span className="flex items-center gap-1" data-testid="help-request-diagnosing">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t`Diagnosing privately… you can leave, the answer lands here.`}
        </span>
      )}
      {held.length > 0 && (
        <span className="flex items-center gap-2" data-testid="help-request-not-shared">
          {t`Context not shared`}
          {!isPrivate && (
            <button
              type="button"
              className="rounded-md border border-input bg-background px-2 py-0.5 font-medium text-foreground shadow-sm hover:bg-accent"
              onClick={() => void share()}
              disabled={sharing}
              data-testid="help-request-share"
            >
              {sharing ? t`Sharing…` : t`Share`}
            </button>
          )}
          <button
            type="button"
            className="text-primary underline-offset-2 hover:underline"
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
