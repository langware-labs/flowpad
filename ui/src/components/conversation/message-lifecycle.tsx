/**
 * Where a message that came IN on a channel is on its way to an answer: Arrived → Handling → Replied.
 *
 * Two inputs, nothing stored:
 *   - the live `stream_inbox.<provider>.message.status` tag (`emit_message_status`): an agent on this machine took
 *     the message (`handling`);
 *   - the feed itself: an answer that quotes a message (or any answer after it) is its "replied".
 * Nobody taking it leaves it "Arrived — not picked up yet". The tag is live only, so after a reload an unanswered
 * message reads "Arrived" until the next status.
 */
import { useCallback, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { Trans } from '@lingui/react/macro';
import { isProcessFailed, isProcessLive, type AgenticProcess, type FlowMessage } from '@sdk';
import { SenderKind, senderOf } from '@sdk/models/MessageSender';
import type { FlowEvent } from '@sdk/tags/EventBus';
import { useOnTag } from '@sdk/react/hooks';
import { cn } from '@src/lib/utils';

export const LifecycleState = {
  Arrived: 'arrived',
  Handling: 'handling',
  Replied: 'replied',
  /** An automation's agent took it and did not finish. */
  Failed: 'failed',
} as const;
export type LifecycleState = (typeof LifecycleState)[keyof typeof LifecycleState];

export interface Lifecycle {
  state: LifecycleState;
  /** For `Failed`: what the session said. */
  detail?: string;
}

// One object per state: a recomputed feed hands every bubble the same value, so nothing re-renders for nothing.
const ARRIVED: Lifecycle = { state: LifecycleState.Arrived };
const HANDLING: Lifecycle = { state: LifecycleState.Handling };
const REPLIED: Lifecycle = { state: LifecycleState.Replied };

/** The origin keys of a channel's messages some agent here has taken (`handling`). None for a non-channel. */
export function useHandledKeys(sourceId: string | null | undefined): ReadonlySet<string> {
  const [handled, setHandled] = useState<ReadonlySet<string>>(() => new Set());
  const onStatus = useCallback((event: FlowEvent) => {
    const key = String((event.data as { message_id?: string } | undefined)?.message_id ?? '');
    // Unchanged when already known: no new set, no recomputed feed.
    if (key) setHandled((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
  }, []);
  // Without a source the target matches no event: the subscription stays, but it never fires.
  useOnTag('stream_inbox.*.message.status', onStatus, { target: `data_source:${sourceId || '-'}` });
  return handled;
}

/** Each incoming message's lifecycle, by message id — from the feed (in order), what was heard, and the
 *  sessions an automation started on them (`useMessageAutomationSessions`): a running one is handling, a failed
 *  one that never answered is failed. */
export function lifecyclesOf(
  ordered: FlowMessage[],
  handled: ReadonlySet<string>,
  sessions?: ReadonlyMap<string, AgenticProcess>,
): Map<string, Lifecycle> {
  const out = new Map<string, Lifecycle>();
  const open: FlowMessage[] = [];
  for (const fm of ordered) {
    if (senderOf(fm)?.kind === SenderKind.External) {
      open.push(fm);
      const session = sessions?.get(fm.id);
      const status = String(session?.status ?? '');
      if (session && isProcessLive(status)) out.set(fm.id, HANDLING);
      else if (session && isProcessFailed(status)) out.set(fm.id, { state: LifecycleState.Failed, detail: String(session.name ?? '') });
      else out.set(fm.id, fm.origin?.key && handled.has(fm.origin.key) ? HANDLING : ARRIVED);
      continue;
    }
    // An answer: what it quotes is replied, and so is everything still open before it (a channel that threads
    // instead of quoting, Slack, names no message).
    for (const m of open) out.set(m.id, REPLIED);
    open.length = 0;
    if (fm.reply_to_id && out.has(fm.reply_to_id)) out.set(fm.reply_to_id, REPLIED);
  }
  return out;
}

/** On a channel nobody here answers (a person's own), only a message an automation took has a way to an
 *  answer: the lines of the others are dropped. */
export function onlyWithSessions(
  lifecycles: ReadonlyMap<string, Lifecycle>,
  sessions: ReadonlyMap<string, AgenticProcess>,
): Map<string, Lifecycle> {
  return new Map([...lifecycles].filter(([id]) => sessions.has(id)));
}

const STEPS = [LifecycleState.Arrived, LifecycleState.Handling, LifecycleState.Replied] as const;

/** One incoming message's line under its bubble. */
export function MessageLifecycle({ lifecycle }: { lifecycle: Lifecycle }) {
  const { state } = lifecycle;
  if (state === LifecycleState.Replied) {
    return (
      <p
        className="ms-10 flex items-center gap-1 text-[10px] text-muted-foreground"
        data-testid="message-lifecycle"
        data-state={state}
      >
        <Check className="size-3" />
        <Trans>Replied</Trans>
      </p>
    );
  }
  if (state === LifecycleState.Failed) {
    return (
      <p
        className="ms-10 flex items-center gap-1 text-[10px] text-muted-foreground"
        data-testid="message-lifecycle"
        data-state={state}
      >
        <span className="font-semibold text-foreground">
          <Trans>Didn’t finish</Trans>
        </span>
        {lifecycle.detail && <span>· {lifecycle.detail}</span>}
      </p>
    );
  }
  const at = state === LifecycleState.Handling ? 1 : 0;
  const labels = [
    at === 0 ? <Trans>Arrived — not picked up yet</Trans> : <Trans>Arrived</Trans>,
    <Trans>Handling</Trans>,
    <Trans>Replied</Trans>,
  ];
  return (
    <p
      className="ms-10 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground"
      data-testid="message-lifecycle"
      data-state={state}
    >
      {STEPS.map((step, i) => (
        <span key={step} className="flex items-center gap-1.5">
          {i > 0 && <span aria-hidden>›</span>}
          <span className={cn(i === at ? 'font-semibold text-foreground' : i > at && 'opacity-50')}>
            {i === at && state === LifecycleState.Handling && <Loader2 className="me-1 inline size-3 animate-spin" />}
            {labels[i]}
          </span>
        </span>
      ))}
    </p>
  );
}
