import { useCallback, useEffect, useState } from 'react';
import { Trans } from '@lingui/react/macro';
import apiClient from '@sdk/client';
import { Sparkles } from 'lucide-react';
import { Button } from '@src/components/ui/button';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

/**
 * AI Assist on a question: hand it to the op's agent, which follows the same guide the person
 * reads and answers THIS question — the op cannot tell who answered. The form stays usable while
 * the agent works (the first answer wins), and a failed assist leaves the question to the person.
 *
 * Drawn by every renderer of a question (`AskForm`, `AskModal`, `AskView`) under the guide.
 */

export interface AssistState {
  state: 'running' | 'failed' | 'done';
  detail: string;
  /** The agent process doing it (`agentic_process-<id>`), once it has started. */
  process: string;
}

/** How often a running assist is looked at. The question's own read, no new route. */
const POLL_MS = 2000;

export function AskAssist({
  questionId,
  available,
  initial,
  onAnswered,
}: {
  questionId: string;
  /** The op names an agent (`assist_available` on the question). */
  available?: boolean;
  initial?: AssistState | null;
  /** The question settled while the agent worked — it answered. */
  onAnswered: () => void;
}) {
  const { navigation } = useDockNavigation();
  const [assist, setAssist] = useState<AssistState | null>(initial ?? null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => setAssist(initial ?? null), [questionId, initial]);

  const running = assist?.state === 'running';
  useEffect(() => {
    if (!running) return;
    let alive = true;
    const timer = setInterval(() => {
      void (async () => {
        const res = await apiClient
          .get<{ assist?: AssistState | null }>(`/api/v1/ask/${questionId}`)
          .catch(() => null);
        if (!alive) return;
        // Gone while the agent worked: the agent answered it (a person's answer settles the form itself).
        if (!res) onAnswered();
        else if (res.assist) setAssist(res.assist);
      })();
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [running, questionId, onAnswered]);

  const start = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      setAssist(await apiClient.post<AssistState>(`/api/v1/ask/${questionId}/assist`));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }, [questionId]);

  if (!available) return null;
  const process = assist?.process;
  return (
    <div className="flex flex-col gap-2" data-testid="ask-assist">
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          data-testid="ask-assist-start"
          disabled={busy || running}
          onClick={() => void start()}
        >
          <Sparkles className="mr-1.5 h-3.5 w-3.5" />
          {assist?.state === 'failed' ? <Trans>Try AI Assist again</Trans> : <Trans>AI Assist</Trans>}
        </Button>
        {running ? (
          <span className="text-xs text-muted-foreground" data-testid="ask-assist-running">
            <Trans>AI Assist is working on it — you can still answer yourself.</Trans>
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">
            <Trans>Let an agent follow the steps above and answer for you.</Trans>
          </span>
        )}
      </div>
      {running && assist?.detail ? (
        <p className="text-xs text-muted-foreground" data-testid="ask-assist-detail">
          {assist.detail}
        </p>
      ) : null}
      {assist?.state === 'failed' || error ? (
        // Tinted row, red border, text in the foreground colour — never red text on black.
        <div
          className="rounded border border-destructive/60 bg-destructive/10 px-3 py-2 text-sm text-foreground"
          data-testid="ask-assist-failed"
        >
          {error || assist?.detail}
        </div>
      ) : null}
      {process ? (
        <button
          type="button"
          className="self-start text-xs text-primary underline-offset-2 hover:underline"
          data-testid="ask-assist-process"
          onClick={() => navigation.openDock(DockPointer.forShell(process))}
        >
          <Trans>Watch the agent</Trans>
        </button>
      ) : null}
    </div>
  );
}
