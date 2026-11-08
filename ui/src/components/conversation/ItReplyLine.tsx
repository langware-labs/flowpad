import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Loader2 } from 'lucide-react';
import { Agent } from '@sdk';
import type { ItReplyMeta } from '@sdk/entities/agent';
import { Button } from '@src/components/ui/button';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';
import { itReplyView, itValueChips } from './it-reply';
import { WikiTip } from '@src/components/wiki-tip';

const TONE: Record<string, string> = {
  ok: 'text-emerald-600 dark:text-emerald-400',
  warn: 'text-amber-600 dark:text-amber-400',
  bad: 'text-red-600 dark:text-red-400',
  muted: 'text-muted-foreground',
};

/**
 * Under a machine's reply in an IT conversation: the returned value's fields as chips, the reply's state, and what
 * to do about it -- "Open machine", or "Enable and run" when the machine was IT Disabled (enables it for that one
 * machine, then asks it the conversation's own request again -- text, files and answer shape -- into this thread).
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
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  const view = itReplyView(reply);
  const chips = itValueChips(reply.value);
  // Built once: constructing an entity registers it in the shared cache.
  const [agentEntity] = useState(() => new Agent({ id: agentId }));
  const agent = () => agentEntity;

  const turnOnAndRun = async () => {
    setBusy(true);
    try {
      await agent().setItSessions([reply.node_typeid], true);
      await agent().itRerun(conversationId, [reply.node_typeid]);
    } catch (e) {
      notify.error({ title: t`Could not run it there`, message: errorMessage(e, ''), forceToast: true });
    } finally {
      setBusy(false);
    }
  };

  const openMachine = async () => {
    // Opened in the click, filled after the call: a window opened after an await is eaten by popup blockers.
    const tab = window.open('about:blank', '_blank');
    try {
      const result = await agent().managePublicDeployment(reply.node_typeid, 'open');
      if (result.workspace_url && tab) tab.location.href = result.workspace_url;
      else tab?.close();
    } catch (e) {
      tab?.close();
      notify.error({ title: t`Could not open the machine`, message: errorMessage(e, ''), forceToast: true });
    }
  };

  return (
    <div className="mt-1 flex flex-col gap-1" data-testid="it-reply-line">
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1" data-testid="it-reply-fields">
          {chips.map((c) => (
            <span
              key={c}
              className="inline-flex h-5 items-center rounded-full border border-border bg-muted/50 px-2 text-[10px] font-medium leading-none text-muted-foreground"
            >
              {c}
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <WikiTip wikiword="IT Enabled" label={view.label} learnMore openDelay={400}>
          <span
            className={`flex items-center gap-1 rounded-full border px-2 py-0.5 ${TONE[view.tone]}`}
            data-testid="it-reply-state"
            data-it-state={reply.state}
            data-it-woke={reply.woke ? 'true' : 'false'}
          >
            {view.label}
          </span>
        </WikiTip>
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
      </div>
    </div>
  );
}
