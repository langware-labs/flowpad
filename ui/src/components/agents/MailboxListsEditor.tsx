import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  type Agent,
  type AgentMailbox,
  type AgentMailboxState,
  type MailboxConfiguration,
  type MailboxList,
  type User,
} from '@sdk';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { useContacts } from '@src/components/contact-picker/use-contacts';
import { resolveEntry } from './mailbox-entries';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';
import { cn } from '@src/lib/utils';

type Direction = 'receiving' | 'sending';

/** Each direction's two lists and its "Open to all" switch, by the Hub's names. */
const LISTS: Record<
  Direction,
  { allowed: MailboxList; blocked: MailboxList; open: 'open_senders' | 'open_recipients' }
> = {
  receiving: { allowed: 'allowed_senders', blocked: 'blocked_senders', open: 'open_senders' },
  sending: { allowed: 'allowed_recipients', blocked: 'blocked_recipients', open: 'open_recipients' },
};

const TAB = 'rounded-sm px-3 py-1 text-xs transition-colors';
const TAB_ON = 'bg-accent text-primary ring-1 ring-primary/40';
const TAB_OFF = 'text-muted-foreground hover:text-foreground';

/**
 * The agent mailbox's two directions — Receiving (who it reads and answers) and Sending (who it may
 * write to) — each an Allowed and a Blocked list in ONE format, and an "Open to all" switch that turns
 * the Allowed list off (Blocked still applies). Every change saves through `agent.configureMailbox`
 * and shows the lists as the Hub stored them; the Hub enforces Sending on every send.
 */
export function MailboxListsEditor({
  agent,
  mailbox,
  onSaved,
}: {
  agent: Agent | null;
  mailbox: AgentMailbox;
  onSaved: (state: AgentMailboxState) => void;
}) {
  const { t } = useLingui();
  const [direction, setDirection] = useState<Direction>('receiving');
  const [busy, setBusy] = useState(false);
  const { contacts } = useContacts();
  const lists = LISTS[direction];
  const open = Boolean(mailbox[lists.open]);

  const save = async (patch: MailboxConfiguration) => {
    setBusy(true);
    try {
      if (!agent) throw new Error(t`This mailbox's agent is gone`);
      onSaved(await agent.configureMailbox(patch));
    } catch (e) {
      notify.error({
        title: t`Could not save the mailbox lists`,
        message: errorMessage(e, String(e)),
        forceToast: true,
      });
    } finally {
      setBusy(false);
    }
  };

  const hint =
    direction === 'receiving'
      ? t`Who the agent reads and answers. Anyone else's mail is kept, not answered.`
      : t`Who the agent may send to. A send to anyone else is refused.`;

  return (
    <div className="flex flex-col gap-2" data-testid="mailbox-lists">
      <div className="flex items-center justify-between gap-3">
        <div className="inline-flex gap-0.5 rounded-md border border-border bg-muted/40 p-0.5" role="tablist">
          {(['sending', 'receiving'] as const).map((d) => (
            <button
              key={d}
              type="button"
              role="tab"
              aria-selected={direction === d}
              className={cn(TAB, direction === d ? TAB_ON : TAB_OFF)}
              onClick={() => setDirection(d)}
              data-testid={`mailbox-tab-${d}`}
            >
              {d === 'sending' ? <Trans>Sending</Trans> : <Trans>Receiving</Trans>}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={open}
            disabled={busy}
            onChange={(e) => void save({ [lists.open]: e.target.checked })}
            data-testid={`mailbox-open-${direction}`}
          />
          <span title={t`The Allowed list is switched off; Blocked still applies.`}>
            <Trans>Open to all</Trans>
          </span>
        </label>
      </div>
      <p className="text-xs text-muted-foreground">{hint}</p>
      <div className="grid gap-3 md:grid-cols-2">
        <EntryList
          title={t`Allowed`}
          entries={(mailbox[lists.allowed] as string[]) ?? []}
          dimmed={open}
          busy={busy}
          contacts={contacts}
          onChange={(next) => void save({ [lists.allowed]: next })}
          testId={`mailbox-${direction}-allowed`}
        />
        <EntryList
          title={t`Blocked`}
          entries={(mailbox[lists.blocked] as string[]) ?? []}
          busy={busy}
          contacts={contacts}
          onChange={(next) => void save({ [lists.blocked]: next })}
          testId={`mailbox-${direction}-blocked`}
        />
      </div>
    </div>
  );
}

function EntryList({
  title,
  entries,
  busy,
  dimmed = false,
  contacts,
  onChange,
  testId,
}: {
  title: string;
  entries: string[];
  busy: boolean;
  dimmed?: boolean;
  contacts: User[];
  onChange: (next: string[]) => void;
  testId: string;
}) {
  const { t } = useLingui();
  const [adding, setAdding] = useState('');
  const nameOf = (entry: string) => contacts.find((u) => u.email && u.email.toLowerCase() === entry)?.name;
  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-xl border border-border bg-card px-4 py-3 text-sm',
        dimmed && 'opacity-50',
      )}
      data-testid={testId}
    >
      <span className="text-xs font-medium">
        {title} ({entries.length})
      </span>
      <div className="flex flex-wrap gap-2" data-testid={`${testId}-entries`}>
        {entries.length === 0 && (
          <span className="text-xs text-muted-foreground">
            <Trans>Empty</Trans>
          </span>
        )}
        {entries.map((entry) => (
          <span key={entry} className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
            {entry}
            {nameOf(entry) && <span className="text-[10px] text-muted-foreground">{nameOf(entry)}</span>}
            <button
              type="button"
              aria-label={t`Remove ${entry}`}
              className="text-muted-foreground hover:text-foreground"
              disabled={busy}
              onClick={() => onChange(entries.filter((x) => x !== entry))}
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
          const entry = resolveEntry(adding, contacts);
          if (!entry) {
            notify.error({
              title: t`Not an address, a domain or a contact`,
              message: t`Type an email, @domain, or the exact name of someone in your contacts.`,
              forceToast: true,
            });
            return;
          }
          setAdding('');
          onChange([...entries, entry]);
        }}
      >
        <Input
          className="h-8"
          placeholder={t`An address, a name, or @domain`}
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
          <Trans>+ Add</Trans>
        </Button>
      </form>
    </div>
  );
}
