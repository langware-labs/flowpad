import { DiagnosisActionButtons } from '@src/components/diagnose/diagnosis-action-buttons';
import { useDiagnosisReport } from '@src/components/diagnose/use-diagnosis-report';
import { recipientsLabel, useDiagnoseRunStore } from '@src/components/diagnose/diagnose-run-store';
import { ShareWithRow } from '@src/components/diagnose/ShareWithRow';
import { prefsAfterAnswer, SendOnceDoneDialog, shouldAsk } from '@src/components/diagnose/SendOnceDoneDialog';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Textarea } from '@src/components/ui/textarea';
import {
  AttachFilesButton,
  PickedFileList,
  useAnnotatedImagePaste,
  usePickedFiles,
} from '@src/components/conversation/FileAttachmentPicker';
import { cn } from '@src/lib/utils';
import { KindValue } from '@src/components/value-viewer/KindValue';
import { dataContext, PrefKey, type HelpRecipient } from '@sdk';
import { usePreference } from '@src/hooks/use-preference';
import { animateMinimizeToProcessChip } from '@src/lib/minimize-to-element';
import { DockPointer } from '@src/navigation/DockPointer';
import { navigateTo } from '@src/notifications/commands';
import { CheckCircle2, Info, Loader2, Stethoscope, XCircle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

/** What an error / warning toast hands the window: the text it shows and diagnoses. */
export interface DiagnoseSeed {
  detail: string;
  kind: 'error' | 'warning';
}

interface DiagnoseModalProps {
  open: boolean;
  onClose: () => void;
  /** Open the full-diagnosis popup in place of this one (the "View diagnosis" button). */
  onViewDiagnosis: (args: { diagnosisId: string; conversationId?: string }) => void;
  /** Opened from an error / warning: that text is the subject (the one window for both entry points). */
  seed?: DiagnoseSeed | null;
  /** False where the window is mounted above the router (the error-toast host in `main.tsx`, which
   *  must survive a crashed route): the parts that need the router — Forward, the sweep viewer —
   *  are left out; the finish toast carries Open / Send to instead. */
  inRouter?: boolean;
}

/** The prompt a seeded diagnosis runs with — what the error toast's window always sent. */
function seededPrompt(seed: DiagnoseSeed, notes: string): string {
  return [`analyze the ${seed.kind}: ${seed.detail}`, notes.trim()].filter(Boolean).join('\n\n');
}

/**
 * Diagnose Flowpad — THE window, from the footer and from an error / warning toast alike.
 *
 * Who gets the results is picked here (help desk chips, the address book, an email), and "Send report
 * once done" (remembered) decides whether they go when the run ends. The run lives in
 * `useDiagnoseRunStore`, not here: closing the window never stops it, and its finish toast says what
 * was sent — the window is usually long closed by then.
 */
export function DiagnoseModal({ open, onClose, onViewDiagnosis, seed = null, inRouter = true }: DiagnoseModalProps) {
  const { t } = useLingui();
  const [message, setMessage] = useState('');
  const [picked, setPicked] = useState<HelpRecipient[]>([]);
  const [asking, setAsking] = useState(false);
  const [sendWhenDone, setSendWhenDone] = usePreference<boolean>(PrefKey.DIAGNOSE_SEND_WHEN_DONE);
  const [askBeforeSend, setAskBeforeSend] = usePreference<boolean>(PrefKey.DIAGNOSE_ASK_BEFORE_SEND);
  const { running, lines, done, share, start, reset } = useDiagnoseRunStore();
  const started = running || lines.length > 0 || !!done;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const {
    report,
    forward,
    busy: reporting,
    error: reportError,
    reset: resetReport,
  } = useDiagnosisReport(done?.diagnosisId ?? null);
  const {
    inputId,
    files,
    rejected,
    dragging,
    addFiles,
    removeAt,
    clear: clearFiles,
    dragProps,
  } = usePickedFiles({
    enabled: true,
    disabled: started,
  });
  const handlePaste = useAnnotatedImagePaste(addFiles, { enabled: !started, setText: setMessage });

  // A fresh window on every open — unless a diagnosis is still running: then it shows that run.
  useEffect(() => {
    if (open) {
      setMessage('');
      setPicked([]);
      setAsking(false);
      reset();
      resetReport();
      clearFiles();
    }
  }, [open, reset, resetReport, clearFiles]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const run = useCallback(
    (send: boolean) => {
      const text = seed ? seededPrompt(seed, message) : message;
      const share = picked.length
        ? { share_with: picked, send_when_done: send, conversation_id: crypto.randomUUID() }
        : null;
      start(text, files, share);
    },
    [seed, message, picked, files, start],
  );

  const onDiagnose = () => {
    if (shouldAsk(picked.length, !!sendWhenDone, askBeforeSend !== false)) setAsking(true);
    else run(!!sendWhenDone);
  };

  const handleClose = useCallback(() => {
    // The run goes on without the window: fly it into the footer's process chip.
    if (running) animateMinimizeToProcessChip(contentRef.current);
    onClose();
  }, [onClose, running]);

  const handleReportIssue = useCallback(async () => {
    if (await report()) handleClose();
  }, [report, handleClose]);

  const handleForward = useCallback(
    async (conversationId: string) => {
      if (await forward(conversationId)) {
        navigateTo(DockPointer.forConversation(conversationId).toUrl());
        handleClose();
      }
    },
    [forward, handleClose],
  );

  const goesTo = recipientsLabel(started ? (share?.share_with ?? []) : picked);
  const isWarning = seed?.kind === 'warning';

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent ref={contentRef} className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Stethoscope className="h-4 w-4" />
            {seed ? (
              isWarning ? (
                <Trans>Diagnose this warning</Trans>
              ) : (
                <Trans>Diagnose this error</Trans>
              )
            ) : (
              <Trans>Diagnose Flowpad</Trans>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className={cn('space-y-3', dragging && 'rounded-md ring-1 ring-primary')} {...dragProps}>
          {!started && (
            <p className="text-xs text-muted-foreground">
              {seed ? (
                <Trans>
                  Run a diagnosis on the {seed.kind} below? The assistant inspects Flowpad, repairs what's safe, and
                  records the result.
                </Trans>
              ) : (
                <Trans>
                  Describe the issue or paste the error, then run the diagnosis. Leave it empty for a full diagnostic
                  sweep. The assistant inspects Flowpad, repairs what's safe, and records the result.
                </Trans>
              )}
            </p>
          )}

          {seed && (
            <div
              className={cn(
                'rounded-md border px-3 py-2',
                isWarning ? 'border-yellow-500/30 bg-yellow-500/5' : 'border-destructive/30 bg-destructive/5',
              )}
            >
              <div
                className={cn(
                  'mb-1 text-[10px] font-semibold uppercase tracking-wide',
                  isWarning ? 'text-yellow-600 dark:text-yellow-500/80' : 'text-destructive/80',
                )}
              >
                {isWarning ? <Trans>Warning</Trans> : <Trans>Error</Trans>}
              </div>
              <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground">
                {seed.detail}
              </pre>
            </div>
          )}

          {!started && (
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onPaste={handlePaste}
              placeholder={seed ? t`Anything to add? (optional)` : t`What went wrong? (leave empty for a full sweep)`}
              className="min-h-[60px] text-xs"
            />
          )}

          <PickedFileList files={files} rejected={rejected} disabled={started} onRemoveAt={removeAt} />

          {!started && (
            <>
              <ShareWithRow projectId={dataContext.project?.id ?? null} onChange={setPicked} />
              <div className="flex flex-col gap-0.5">
                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={!!sendWhenDone}
                    onChange={(e) => setSendWhenDone(e.target.checked)}
                    data-testid="diagnose-send-once-done"
                  />
                  {t`Send report once done`}
                </label>
                <p className="ps-5 text-[11px] text-muted-foreground">
                  {!picked.length
                    ? t`When it finishes, send the results to the people above. Flowpad remembers this choice.`
                    : sendWhenDone
                      ? t`Sends the results to ${goesTo} when the diagnosis finishes — even if you close this window.`
                      : t`Off — Flowpad asks before it sends anything to ${goesTo}. Your choice is remembered.`}
                </p>
              </div>
            </>
          )}

          {started && (
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
                  <span>
                    <Trans>Working…</Trans>
                  </span>
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
                    {done.shared.length
                      ? t`Diagnosis sent to ${done.shared.map((s) => s.to).join(', ')}.`
                      : done.ok
                        ? done.conversationId
                          ? t`Diagnosis recorded.`
                          : t`Diagnostic complete — no issue found.`
                        : t`Diagnosis was not recorded — try again.`}
                  </span>
                </div>
              )}
            </div>
          )}

          {inRouter && done && !done.ok && done.diagnosis && (
            <div className="max-h-80 overflow-y-auto rounded-md border p-2" data-testid="diagnose-sweep-result">
              <KindValue kind="diagnosis" value={done.diagnosis} />
            </div>
          )}

          {running && (
            <div className="flex items-start gap-2 rounded-md border border-blue-500/40 bg-blue-500/10 px-2.5 py-2 text-[11px] font-medium text-blue-700 dark:border-blue-400/40 dark:text-blue-300">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div className="space-y-0.5">
                <div className="font-semibold">
                  <Trans>You can close this window.</Trans>
                </div>
                <div className="font-normal">
                  {share?.send_when_done && share.share_with.length
                    ? t`When it is done, the results go to ${goesTo} in a new conversation titled with the diagnosis.`
                    : t`This runs in the background — when it's done, the result (and any actions) waits on your Home feed.`}
                </div>
              </div>
            </div>
          )}

          {!started && (
            <div className="flex items-center justify-between">
              <AttachFilesButton
                inputId={inputId}
                onFiles={addFiles}
                title={t`Attach files or a screenshot (or paste one into the description)`}
                testId="diagnose-attach"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleClose}
                  className="rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted/50"
                >
                  <Trans>Cancel</Trans>
                </button>
                <button
                  type="button"
                  onClick={onDiagnose}
                  className="flex items-center justify-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
                  data-testid="diagnose-run"
                >
                  <Stethoscope className="h-3.5 w-3.5" />
                  <Trans>Run diagnosis</Trans>
                </button>
              </div>
            </div>
          )}

          {inRouter && done?.ok && done.conversationId && !done.shared.length && (
            <DiagnosisActionButtons
              suggestedConversationId={done.conversationId}
              canReport={!!done.diagnosisId}
              diagnosisId={done.diagnosisId ?? undefined}
              busy={reporting}
              error={reportError}
              onDismiss={handleClose}
              onReportIssue={() => void handleReportIssue()}
              onForward={(conversationId) => void handleForward(conversationId)}
              onForwardedNew={handleClose}
            />
          )}

          {started && (
            <div className="flex justify-end gap-2">
              {running ? null : done?.shared.length ? (
                <button
                  type="button"
                  onClick={() => {
                    navigateTo(DockPointer.forConversation(done.shared[0].conversation_id).toUrl());
                    handleClose();
                  }}
                  className="rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted/50"
                >
                  <Trans>Open conversation</Trans>
                </button>
              ) : done?.ok && done.diagnosisId ? (
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
              ) : null}
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
      <SendOnceDoneDialog
        open={asking}
        to={goesTo}
        onCancel={() => setAsking(false)}
        onAnswer={(answer) => {
          const next = prefsAfterAnswer(answer);
          if (next.sendWhenDone !== undefined) setSendWhenDone(next.sendWhenDone);
          if (next.askBeforeSend !== undefined) setAskBeforeSend(next.askBeforeSend);
          setAsking(false);
          run(answer.send);
        }}
      />
    </Dialog>
  );
}
