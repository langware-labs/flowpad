import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Loader2, Stethoscope, XCircle } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { streamDiagnose, type DiagnoseEvent } from '@src/components/diagnose/diagnose-stream';
import { useDiagnoseErrorStore, type DiagnoseKind } from './diagnose-error-store';

interface Line {
  kind: 'narration' | 'status' | 'error';
  text: string;
}

/** The prompt the diagnosis is seeded with — exactly what runs on confirm. */
function diagnosePrompt(detail: string, kind: DiagnoseKind): string {
  return `analyze the ${kind}: ${detail}`;
}

/**
 * Global confirmation + run host for "diagnose this error / warning". Mounted once
 * in App. An error/warning toast, badge or warnings-popover row opens it via
 * `useDiagnoseErrorStore.open(detail, kind)`; the modal asks the user to confirm,
 * then streams the Flowpad self-diagnosis seeded with `analyze the <kind>: <detail>`.
 */
export function DiagnoseErrorModal() {
  const errorText = useDiagnoseErrorStore((s) => s.detail);
  const kind = useDiagnoseErrorStore((s) => s.kind);
  const close = useDiagnoseErrorStore((s) => s.close);

  const [started, setStarted] = useState(false);
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [done, setDone] = useState<{ ok: boolean } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const open = errorText !== null;

  // Reset whenever the modal (re)opens for a new error.
  useEffect(() => {
    if (open) {
      setStarted(false);
      setRunning(false);
      setLines([]);
      setDone(null);
    }
  }, [open]);

  // Auto-scroll the activity log to the latest line.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  // Abort any in-flight stream on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  const handleEvent = useCallback((ev: DiagnoseEvent) => {
    if (ev.type === 'narration') setLines((p) => [...p, { kind: 'narration', text: ev.text }]);
    else if (ev.type === 'status') setLines((p) => [...p, { kind: 'status', text: ev.text.trim() }]);
    else if (ev.type === 'error') setLines((p) => [...p, { kind: 'error', text: ev.text.trim() }]);
    else if (ev.type === 'done') setDone({ ok: ev.ok });
    // 'progress' / 'flush' are liveness cosmetics; the spinner covers them.
  }, []);

  const runDiagnose = useCallback(async () => {
    if (errorText === null) return;
    setStarted(true);
    setRunning(true);
    setLines([]);
    setDone(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await streamDiagnose(diagnosePrompt(errorText, kind), handleEvent, controller.signal);
    } catch (e) {
      if (!controller.signal.aborted) {
        const text = e instanceof Error ? e.message : String(e);
        setLines((p) => [...p, { kind: 'error', text: `Diagnose failed: ${text}` }]);
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [errorText, kind, handleEvent]);

  const handleClose = useCallback(() => {
    abortRef.current?.abort();
    close();
  }, [close]);

  // The detail block and heading follow what was clicked, so a diagnosed warning
  // is never mislabelled (and never re-tinted) as an error.
  const isWarning = kind === 'warning';
  const detailBlockClass = isWarning
    ? 'rounded-md border border-yellow-500/30 bg-yellow-500/5 px-3 py-2'
    : 'rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2';
  const detailLabelClass = isWarning
    ? 'mb-1 text-[10px] font-semibold uppercase tracking-wide text-yellow-600 dark:text-yellow-500/80'
    : 'mb-1 text-[10px] font-semibold uppercase tracking-wide text-destructive/80';

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Stethoscope className="h-4 w-4" />
            {isWarning ? 'Diagnose this warning' : 'Diagnose this error'}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          {!started && (
            <p className="text-xs text-muted-foreground">
              Run a diagnosis on the {isWarning ? 'warning' : 'error'} below? The assistant inspects Flowpad, repairs
              what's safe, and records the result.
            </p>
          )}

          {/* The subject being diagnosed — formatted as a quoted code block. */}
          <div className={detailBlockClass}>
            <div className={detailLabelClass}>{isWarning ? 'Warning' : 'Error'}</div>
            <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground">
              {errorText}
            </pre>
          </div>

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
                  <span>Working…</span>
                </div>
              )}
              {done && (
                <div
                  className={`mt-1.5 flex items-center gap-1.5 font-medium ${
                    done.ok ? 'text-green-600 dark:text-green-400' : 'text-destructive'
                  }`}
                >
                  {done.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
                  <span>{done.ok ? 'Diagnosis recorded.' : 'Diagnosis was not recorded — try again.'}</span>
                </div>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2">
            {!started ? (
              <>
                <button
                  type="button"
                  onClick={handleClose}
                  className="rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted/50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void runDiagnose()}
                  className="flex items-center justify-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  <Stethoscope className="h-3.5 w-3.5" />
                  Run diagnosis
                </button>
              </>
            ) : (
              !running && (
                <button
                  type="button"
                  onClick={handleClose}
                  className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  Close
                </button>
              )
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
