import { DiagnosisActionButtons } from '@src/components/diagnose/diagnosis-action-buttons';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Textarea } from '@src/components/ui/textarea';
import { ActionInfo, dataManager, forwardDiagnosis, sendDiagnosisEmailReport } from '@sdk';
import { streamDiagnose, type DiagnoseEvent } from '@src/components/diagnose/diagnose-stream';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { CheckCircle2, Info, Loader2, Stethoscope, XCircle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

interface DiagnoseModalProps {
  open: boolean;
  onClose: () => void;
  /** Open the full-diagnosis popup in place of this one (the "View diagnosis" button). */
  onViewDiagnosis: (args: { diagnosisId: string; conversationId?: string }) => void;
}

interface Line {
  kind: 'narration' | 'status' | 'error';
  text: string;
}

interface DoneState {
  ok: boolean;
  diagnosisId: string | null;
  conversationId: string | null;
  flowMessageId: string | null;
}

export function DiagnoseModal({ open, onClose, onViewDiagnosis }: DiagnoseModalProps) {
  const { t } = useLingui();
  const [message, setMessage] = useState('');
  const [started, setStarted] = useState(false);
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [done, setDone] = useState<DoneState | null>(null);
  const [reporting, setReporting] = useState(false);
  const [reportError, setReportError] = useState<string | undefined>(undefined);
  // Set when the run finished while the user wasn't watching (app minimized / tab
  // backgrounded / another window focused): we posted a Home-Feed card instead, so
  // the modal shows a pointer to it rather than its own report buttons.
  const [handedToFeed, setHandedToFeed] = useState(false);
  const feedHandoffRef = useRef(false); // guards the one-shot feed-card post
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const { navigation } = useDockNavigation();

  // Reset everything whenever the modal is (re)opened.
  useEffect(() => {
    if (open) {
      setMessage('');
      setStarted(false);
      setRunning(false);
      setLines([]);
      setDone(null);
      setReporting(false);
      setReportError(undefined);
      setHandedToFeed(false);
      feedHandoffRef.current = false;
    }
  }, [open]);

  // Auto-scroll the activity log to the latest line.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  // Abort any in-flight stream when the modal unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);

  const handleEvent = useCallback((ev: DiagnoseEvent) => {
    if (ev.type === 'narration') {
      setLines((prev) => [...prev, { kind: 'narration', text: ev.text }]);
    } else if (ev.type === 'status') {
      setLines((prev) => [...prev, { kind: 'status', text: ev.text.trim() }]);
    } else if (ev.type === 'error') {
      setLines((prev) => [...prev, { kind: 'error', text: ev.text.trim() }]);
    } else if (ev.type === 'done') {
      setDone({
        ok: ev.ok,
        diagnosisId: ev.diagnosis_id,
        conversationId: ev.conversation_id,
        flowMessageId: ev.flow_message_id,
      });
      // If the diagnosis finished while the user was NOT watching this modal — the
      // app was minimized, this tab was backgrounded, or another window/app held
      // focus — the result was never seen. Ask the backend to post the Home-Feed card
      // (the one creator, `_post_home_feed_entry`) so the answer reaches the feed:
      // an issue card with Report/Forward, or a no-issue card with the summary. Posting
      // happens for ANY result here (gated on diagnosis_id, not conversation_id) so a
      // user who walked away still gets an answer. The modal-closed (stream-
      // disconnected) case is handled inline by the run and never reaches here, so the
      // two paths can't both fire for one run.
      const userWatching =
        document.visibilityState === 'visible' && document.hasFocus();
      if (ev.ok && ev.diagnosis_id && !userWatching && !feedHandoffRef.current) {
        feedHandoffRef.current = true;
        setHandedToFeed(true);
        const info = new ActionInfo('diagnose_post_feed', null, null, 'POST');
        info.bodyParameters = {
          diagnosis_id: ev.diagnosis_id,
          conversation_id: ev.conversation_id,
          flow_message_id: ev.flow_message_id,
        };
        void dataManager.callAction(info);
      }
    }
    // 'progress' / 'flush' are terminal-only cosmetics; the running spinner covers liveness.
  }, []);

  const runDiagnose = useCallback(async () => {
    setStarted(true);
    setRunning(true);
    setLines([]);
    setDone(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await streamDiagnose(message, handleEvent, controller.signal);
    } catch (e) {
      if (!controller.signal.aborted) {
        const text = e instanceof Error ? e.message : String(e);
        setLines((prev) => [...prev, { kind: 'error', text: `Diagnose failed: ${text}` }]);
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [message, handleEvent]);

  const handleClose = useCallback(() => {
    abortRef.current?.abort();
    onClose();
  }, [onClose]);

  // "Report issue" / "Forward" from the finished-diagnose popup: send the full
  // formatted diagnostic report into the chosen conversation (the same send path
  // the Feed card uses), then close. The body comes from the recorded support
  // FlowMessage; the diagnosis summary is only the no-message fallback.
  // "Report issue" — email the diagnosis to the Flowpad team.
  const handleReportIssue = useCallback(async () => {
    if (!done?.diagnosisId) return;
    setReporting(true);
    setReportError(undefined);
    try {
      await sendDiagnosisEmailReport(done.diagnosisId);
      handleClose();
    } catch (e) {
      setReportError(e instanceof Error ? e.message : 'Failed to send report');
    } finally {
      setReporting(false);
    }
  }, [done, handleClose]);

  // "Forward" — attach the diagnosis entity into the chosen conversation.
  const handleForward = useCallback(
    async (conversationId: string) => {
      if (!done?.diagnosisId) return;
      setReporting(true);
      setReportError(undefined);
      try {
        await forwardDiagnosis(conversationId, done.diagnosisId);
        // Open the conversation we forwarded into, replacing this modal.
        navigation.openDock(DockPointer.forConversation(conversationId));
        handleClose();
      } catch (e) {
        setReportError(e instanceof Error ? e.message : 'Failed to send report');
      } finally {
        setReporting(false);
      }
    },
    [done, handleClose, navigation],
  );

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Stethoscope className="h-4 w-4" />
            <Trans>Diagnose Flowpad</Trans>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            <Trans>
              Describe the issue or paste the error, then run the diagnosis. Leave it empty for a full
              diagnostic sweep. The assistant inspects Flowpad, repairs what's safe, and records the
              result.
            </Trans>
          </p>

          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            disabled={started}
            placeholder={t`What went wrong? (leave empty for a full sweep)`}
            className="min-h-[80px] text-xs"
          />

          {(running || lines.length > 0 || done) && (
            <div
              ref={scrollRef}
              className="max-h-56 overflow-y-auto rounded-md border bg-muted/30 px-2.5 py-2 text-[11px] leading-relaxed"
            >
              {lines.map((line, i) => (
                <div
                  key={i}
                  className={`whitespace-pre-wrap break-words ${
                    line.kind === 'error'
                      ? 'text-destructive'
                      : line.kind === 'narration'
                        ? 'text-foreground'
                        : 'text-muted-foreground'
                  }`}
                >
                  {line.kind === 'narration' ? `▸ ${line.text}` : line.text}
                </div>
              ))}
              {running && (
                <div className="mt-1 flex items-center gap-1.5 text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span><Trans>Working…</Trans></span>
                </div>
              )}
              {done && (
                <div
                  className={`mt-1.5 flex items-center gap-1.5 font-medium ${
                    done.ok ? 'text-green-600 dark:text-green-400' : 'text-destructive'
                  }`}
                >
                  {done.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
                  <span>
                    {done.ok
                      ? done.conversationId
                        ? t`Diagnosis recorded.`
                        : t`Diagnostic complete — no issue found.`
                      : t`Diagnosis was not recorded — try again.`}
                  </span>
                </div>
              )}
            </div>
          )}

          {running && (
            <div className="flex items-start gap-2 rounded-md border border-blue-500/40 bg-blue-500/10 px-2.5 py-2 text-[11px] font-medium text-blue-700 dark:border-blue-400/40 dark:text-blue-300">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                <Trans>
                  This runs in the background — feel free to close this and keep working. When it's
                  done, the result (and any actions) will be waiting on your Home feed.
                </Trans>
              </span>
            </div>
          )}

          {!started && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => void runDiagnose()}
                className="flex items-center justify-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
              >
                <Stethoscope className="h-3.5 w-3.5" />
                <Trans>Diagnose</Trans>
              </button>
            </div>
          )}

          {/* Finished while the user was away → we posted a Home-Feed card (for any
              result); point them there instead of showing buttons they didn't see. */}
          {done?.ok && handedToFeed && (
            <p className="text-[11px] text-muted-foreground">
              You stepped away while this finished, so it was saved to your Home feed — open it
              there{done.conversationId ? ' to report or forward it' : ' to read the result'}.
            </p>
          )}

          {/* Watching at the finish, and it's an issue → the Feed-entry report buttons. */}
          {done?.ok && !handedToFeed && done.conversationId && (
            <DiagnosisActionButtons
              suggestedConversationId={done.conversationId}
              canReport={!!done.diagnosisId}
              busy={reporting}
              error={reportError}
              onDismiss={handleClose}
              onReportIssue={() => void handleReportIssue()}
              onForward={(conversationId) => void handleForward(conversationId)}
            />
          )}

          {(done || (started && !running)) && (
            <div className="flex justify-end gap-2">
              {done?.ok && done.diagnosisId && (
                <button
                  type="button"
                  onClick={() =>
                    onViewDiagnosis({
                      diagnosisId: done.diagnosisId!,
                      conversationId: done.conversationId ?? undefined,
                    })
                  }
                  className="flex items-center justify-center gap-2 rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted/50"
                >
                  <Stethoscope className="h-3.5 w-3.5" />
                  <Trans>View diagnosis</Trans>
                </button>
              )}
              <button
                type="button"
                onClick={handleClose}
                className="flex items-center justify-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                <Trans>Close</Trans>
              </button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
