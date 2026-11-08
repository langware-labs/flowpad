import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { type Agent, type AgentMailboxState } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';

/**
 * The one editor of an agent mailbox's allowlist (`allowed_senders`, hub-stored; empty = nobody).
 *
 * Every add/remove saves through `agent.configureMailbox` and reports the list AS THE BACKEND RETURNED IT
 * (normalized, de-duplicated) — so the Channels screen and the agent mailbox screen cannot drift.
 */
export function AllowedSendersEditor({
  agent,
  allowedSenders,
  onSaved,
  testId,
}: {
  agent: Agent | null;
  allowedSenders: string[];
  onSaved: (allowedSenders: string[], state: AgentMailboxState) => void;
  /** Prefix for `-senders`/`-add-input`/`-add`. */
  testId: string;
}) {
  const { t } = useLingui();
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async (next: string[]) => {
    setBusy(true);
    try {
      if (!agent) throw new Error(t`This mailbox's agent is gone`);
      const state = await agent.configureMailbox({ allowed_senders: next });
      onSaved(state.mailbox?.allowed_senders ?? next, state);
    } catch (e) {
      notify.error({ title: t`Could not save allowed senders`, message: errorMessage(e, String(e)), forceToast: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-card px-4 py-3 text-sm">
      <span className="text-xs text-muted-foreground">
        <Trans>Allowed senders — empty means nobody</Trans>
      </span>
      <div className="flex flex-wrap gap-2" data-testid={`${testId}-senders`}>
        {allowedSenders.map((a) => (
          <span key={a} className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
            {a}
            <button
              type="button"
              aria-label={t`Remove ${a}`}
              className="text-muted-foreground hover:text-foreground"
              disabled={busy}
              onClick={() => void save(allowedSenders.filter((x) => x !== a))}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const v = adding.trim();
          if (!v) return;
          setAdding('');
          void save([...allowedSenders, v]);
        }}
      >
        <Input
          className="h-8"
          placeholder={t`An email address`}
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          data-testid={`${testId}-add-input`}
        />
        <Button
          size="sm"
          variant="outline"
          type="submit"
          disabled={busy || !adding.trim()}
          data-testid={`${testId}-add`}
        >
          <Trans>+ Add sender</Trans>
        </Button>
      </form>
    </div>
  );
}
