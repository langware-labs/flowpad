import { Trans } from '@lingui/react/macro';
import { Loader2 } from 'lucide-react';
import type { ItReplyMeta } from '@sdk/entities/agent';
import { Button } from '@src/components/ui/button';
import { WikiTip } from '@src/components/wiki-tip';
import { TONE, itReplyView, itValueChips } from './it-reply';
import { useItReplyActions } from './use-it-reply-actions';

/** The returned value's top-level fields, as small chips. */
export function ItValueChips({ value, className = '' }: { value: ItReplyMeta['value']; className?: string }) {
  const chips = itValueChips(value);
  if (chips.length === 0) return null;
  return (
    <div className={`flex flex-wrap gap-1 ${className}`} data-testid="it-reply-fields">
      {chips.map((c) => (
        <span
          key={c}
          className="inline-flex h-5 items-center rounded-full border border-border bg-muted/50 px-2 text-[10px] font-medium leading-none text-muted-foreground"
        >
          {c}
        </span>
      ))}
    </div>
  );
}

/** The reply's state, as a pill with its explanation on hover. */
export function ItStatePill({ reply }: { reply: ItReplyMeta }) {
  const view = itReplyView(reply);
  return (
    <WikiTip wikiword="IT Enabled" label={view.label} learnMore openDelay={400}>
      <span
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${TONE[view.tone]}`}
        data-testid="it-reply-state"
        data-it-state={reply.state}
        data-it-woke={reply.woke ? 'true' : 'false'}
      >
        {view.label}
      </span>
    </WikiTip>
  );
}

/** What the reply offers: "Open machine", or "Enable and run" when the machine was IT Disabled. */
export function ItReplyButtons({
  reply,
  agentId,
  conversationId,
}: {
  reply: ItReplyMeta;
  agentId: string;
  conversationId: string;
}) {
  const view = itReplyView(reply);
  const { busy, turnOnAndRun, openMachine } = useItReplyActions(reply, agentId, conversationId);
  return (
    <>
      {view.openMachine && (
        <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={() => void openMachine()}>
          <Trans>Open machine</Trans>
        </Button>
      )}
      {view.turnOnAndRun && (
        <Button
          variant="outline"
          size="sm"
          className="h-6 gap-1 px-2 text-xs"
          disabled={busy}
          onClick={() => void turnOnAndRun()}
          data-testid="it-turn-on-and-run"
        >
          {busy && <Loader2 className="h-3 w-3 animate-spin" />}
          <Trans>Enable and run</Trans>
        </Button>
      )}
    </>
  );
}

/**
 * Under a machine's reply in an IT conversation, when it is not drawn in its request's table (a reply from before
 * operations): the returned value's fields as chips, the reply's state, and what to do about it.
 */
export function ItReplyLine({
  reply,
  agentId,
  conversationId,
}: {
  reply: ItReplyMeta;
  /** The agent whose deployments these are -- the reply's sender. */
  agentId: string;
  conversationId: string;
}) {
  return (
    <div className="mt-1 flex flex-col gap-1" data-testid="it-reply-line">
      <ItValueChips value={reply.value} />
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <ItStatePill reply={reply} />
        <ItReplyButtons reply={reply} agentId={agentId} conversationId={conversationId} />
      </div>
    </div>
  );
}
