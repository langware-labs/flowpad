import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Textarea } from '@src/components/ui/textarea';
import { ActionInfo, dataManager } from '@sdk';
import { CheckCircle2, Loader2, Stethoscope, XCircle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

interface DiagnoseModalProps {
  open: boolean;
  onClose: () => void;
}

// Mirrors the event dicts emitted by `_run_diagnose` (flow_sdk/cli/commands/diagnose_cmd.py),
// forwarded verbatim as SSE by POST /api/v1/diagnose/stream.
type DiagnoseEvent =
  | { type: 'status'; text: string }
  | { type: 'narration'; text: string }
  | { type: 'error'; text: string }
  | { type: 'progress' }
  | { type: 'flush' }
  | { type: 'done'; ok: boolean; diagnosis_id: string | null; feed_posted: boolean };

interface Line {
  kind: 'narration' | 'status' | 'error';
  text: string;
}

export function DiagnoseModal({ open, onClose }: DiagnoseModalProps) {
  const [message, setMessage] = useState('');
  const [started, setStarted] = useState(false);
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [done, setDone] = useState<{ ok: boolean; feed_posted: boolean } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Reset everything whenever the modal is (re)opened.
  useEffect(() => {
    if (open) {
      setMessage('');
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
      setDone({ ok: ev.ok, feed_posted: ev.feed_posted });
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
      // Null-entity graph service action → POST /api/v1/graph/diagnose, streamed.
      const info = new ActionInfo('diagnose', null, null, 'POST', false, true, controller.signal);
      info.bodyParameters = { message };
      const resp = await dataManager.callAction<{ message: string }, Response>(info);
      if (!resp || !resp.body) throw new Error('No streaming response body');

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      // Parse the SSE stream: events are separated by a blank line; each carries a
      // single `data: <json>` field.
      for (;;) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          for (const raw of frame.split('\n')) {
            const trimmed = raw.startsWith('data:') ? raw.slice(5).trim() : '';
            if (!trimmed) continue;
            try {
              handleEvent(JSON.parse(trimmed) as DiagnoseEvent);
            } catch {
              /* ignore malformed frame */
            }
          }
        }
      }
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

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Stethoscope className="h-4 w-4" />
            Diagnose Flowpad
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Describe the issue or paste the error, then run the diagnosis. Leave it empty for a full
            diagnostic sweep. The assistant inspects Flowpad, repairs what's safe, and records the
            result.
          </p>

          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            disabled={started}
            placeholder="What went wrong? (leave empty for a full sweep)"
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
                  className={
                    line.kind === 'error'
                      ? 'text-destructive'
                      : line.kind === 'narration'
                        ? 'text-foreground'
                        : 'text-muted-foreground'
                  }
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
                  <span>
                    {done.ok
                      ? done.feed_posted
                        ? 'Diagnosis recorded.'
                        : 'Diagnostic complete — no issue found.'
                      : 'Diagnosis was not recorded — try again.'}
                  </span>
                </div>
              )}
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
                Diagnose
              </button>
            </div>
          )}

          {done && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleClose}
                className="flex items-center justify-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Close
              </button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
