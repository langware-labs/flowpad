import { useState, type ReactNode } from 'react';
import { AlertTriangle, Check, SquareTerminal, X } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { ProcessCall, ReturnedValue } from '@sdk';
import { cn } from '@src/lib/utils';
import { notify } from '@src/notifications';
import { callOutcome, decideProcessCall, type CallDecision, type CallOutcome } from './process-call';

// SessionCard's own vocabulary: the same tones, dots and action buttons as a live session.
const ACTION =
  'rounded px-2 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';
const BUTTON = `${ACTION} border border-border text-foreground hover:bg-muted`;
const PRIMARY = `${ACTION} bg-blue-600 text-white hover:bg-blue-500`;

type CardState = CallOutcome | 'waiting' | 'running';
const LOOK: Record<CardState, { tone: string; dot: string; icon?: ReactNode }> = {
  waiting: { tone: 'text-muted-foreground', dot: 'bg-muted-foreground' },
  running: { tone: 'text-emerald-700 dark:text-emerald-300', dot: 'bg-emerald-500 animate-pulse' },
  good: { tone: 'text-emerald-700 dark:text-emerald-300', dot: 'bg-emerald-500', icon: <Check className="h-3 w-3" /> },
  bad: { tone: 'text-red-700 dark:text-red-300', dot: 'bg-red-500', icon: <X className="h-3 w-3" /> },
  error: {
    tone: 'text-amber-700 dark:text-amber-300',
    dot: 'bg-amber-500',
    icon: <AlertTriangle className="h-3 w-3" />,
  },
  declined: { tone: 'text-muted-foreground', dot: 'bg-muted-foreground' },
};

interface PromptCallCardProps {
  call: ProcessCall;
  messageId: string;
  conversationId: string;
  /** `sender` sent the call and gets its status; `recipient` approves it and runs it. */
  role: 'sender' | 'recipient';
  /** The other side's name — whose machine it runs on, or who sent it. */
  otherName: string;
  /** The answer, once the receiver replied. */
  answer: ReturnedValue | null;
  /** Running on this machine when the conversation opened. */
  running: boolean;
}

/**
 * A one-shot prompt riding a message: the receiver approves it (every time — no standing grant),
 * it runs once on their machine, and both sides see its outcome here. The sender sees the status
 * and one sentence, never the output.
 */
export function PromptCallCard({
  call,
  messageId,
  conversationId,
  role,
  otherName,
  answer,
  running,
}: PromptCallCardProps) {
  const { t } = useLingui();
  const [started, setStarted] = useState(false);
  const [busy, setBusy] = useState(false);
  const prompt = call.exe?.prompt ?? '';

  const decide = async (decision: CallDecision) => {
    if (busy) return;
    setBusy(true);
    try {
      await decideProcessCall(conversationId, messageId, decision);
      if (decision === 'approve') setStarted(true);
    } catch (e) {
      notify.error({ title: e instanceof Error ? e.message : t`Could not answer the prompt` });
    } finally {
      setBusy(false);
    }
  };

  const state: CardState = answer ? callOutcome(answer) : started || running ? 'running' : 'waiting';
  const seconds = answer?.duration_s ? ` · ${Math.round(answer.duration_s)}s` : '';
  const head = role === 'recipient' ? t`Prompt from ${otherName}` : t`Prompt · runs once on ${otherName}'s machine`;
  const label: Record<CardState, string> = {
    waiting:
      role === 'recipient' ? t`wants to run on your machine` : t`delivered · waiting for ${otherName} to approve`,
    running: t`working…`,
    good: t`good` + seconds,
    bad: t`bad` + seconds,
    error: t`error` + seconds,
    declined: t`declined`,
  };
  const look = LOOK[state];

  return (
    <div
      data-testid="prompt-call-card"
      data-state={state}
      className="mt-1.5 flex max-w-xl flex-col gap-1 rounded-md border border-border bg-muted/30 px-2 py-1 text-xs"
    >
      <div className="flex items-center gap-2">
        <SquareTerminal className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="shrink-0 font-medium text-foreground">{head}</span>
        <span className={cn('h-2 w-2 shrink-0 rounded-full', look.dot)} />
        <span className={cn('inline-flex shrink-0 items-center gap-1', look.tone)} data-testid="prompt-call-status">
          {look.icon}
          {label[state]}
        </span>
      </div>
      <div className="min-w-0 truncate font-mono text-muted-foreground" title={prompt}>
        ❯ {prompt}
      </div>
      {answer?.detail && state !== 'declined' && (
        <div className="whitespace-pre-wrap font-mono text-[11px] text-foreground/90" data-testid="prompt-call-detail">
          {answer.detail}
        </div>
      )}
      {role === 'recipient' && (state === 'waiting' || state === 'running') && (
        <div className="flex items-center gap-1.5 py-0.5">
          {state === 'waiting' ? (
            <>
              <button
                type="button"
                className={PRIMARY}
                disabled={busy}
                onClick={() => void decide('approve')}
                data-testid="prompt-call-approve"
              >
                <Trans>Approve once</Trans>
              </button>
              <button
                type="button"
                className={BUTTON}
                disabled={busy}
                onClick={() => void decide('decline')}
                data-testid="prompt-call-decline"
              >
                <Trans>Decline</Trans>
              </button>
            </>
          ) : (
            <button
              type="button"
              className={BUTTON}
              disabled={busy}
              onClick={() => void decide('stop')}
              data-testid="prompt-call-stop"
            >
              <Trans>Stop</Trans>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
