/**
 * A package — the automations an agent (or wizard) holds — as ONE line with one switch:
 * IF <first condition> [+N] → THEN <the agent>. The "+N" lists every condition; clicking the line shows the
 * members, read only. On or off is the package's, together (``Trigger.setPackageEnabled``).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import type { AutomationSummary } from '@sdk';
import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Switch } from '@src/components/ui/switch';
import { sentenceOf, useAutomationWords } from './automation-words';
import { LineShell, RunNow } from './AutomationRow';
import { IfThenLine } from './IfThenLine';

export function PackageRow({
  parentTypeId,
  members,
  onToggle,
  onRunOnce,
  busy,
}: {
  parentTypeId: string;
  members: AutomationSummary[];
  onToggle: (on: boolean) => void;
  onRunOnce: (member: AutomationSummary) => void;
  busy?: boolean;
}) {
  const { t } = useLingui();
  const words = useAutomationWords();
  const [open, setOpen] = useState(false);
  const name = members[0].parent_name || parentTypeId;
  const on = members.every((m) => m.enabled);
  const sentences = members.map((m) => sentenceOf(words, m.when, m.then));
  const whens = sentences.map((s) => s.when);
  // A rule that waits for an event cannot run "now" without one; the package runs what can.
  const runnable = members.filter((m) => m.kind === 'schedule');
  const more =
    whens.length > 1 ? (
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            onClick={(e) => e.stopPropagation()}
            className="ms-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground"
            title={t`${whens.length} conditions — any one of them starts it`}
            data-testid={`package-conditions-${parentTypeId}`}
          >
            +{whens.length - 1}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-2 text-sm" onClick={(e) => e.stopPropagation()}>
          <div className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            <Trans>Starts when any of these happens</Trans>
          </div>
          {whens.map((when, i) => (
            <div key={members[i].id} className="rounded px-1 py-1" data-testid={`package-condition-${members[i].id}`}>
              {when}
            </div>
          ))}
        </PopoverContent>
      </Popover>
    ) : null;

  return (
    <div data-testid={`package-${parentTypeId}`}>
      <LineShell
        testId={`package-row-${parentTypeId}`}
        title={t`${name}: ${members.length} automations, on or off together`}
        on={on}
        onOpen={() => setOpen((v) => !v)}
        toggle={
          <Switch
            checked={on}
            disabled={busy}
            onCheckedChange={onToggle}
            aria-label={on ? t`Turn ${name} off` : t`Turn ${name} on`}
            data-testid={`package-toggle-${parentTypeId}`}
          />
        }
        action={
          runnable.length ? (
            <RunNow
              busy={busy}
              onClick={() => runnable.forEach(onRunOnce)}
              testId={`package-run-once-${parentTypeId}`}
              title={t`Run its scheduled parts once now; a part that waits for an event runs when one comes.`}
            />
          ) : null
        }
      >
        <IfThenLine when={whens[0]} then={name} more={more} />
      </LineShell>
      {open && (
        <div className="ps-14" data-testid={`package-members-${parentTypeId}`}>
          {members.map((m, i) => (
            <LineShell key={m.id} testId={`package-member-${m.id}`} title={m.description || m.name} on={m.enabled}>
              <IfThenLine when={sentences[i].when} then={sentences[i].then} />
            </LineShell>
          ))}
        </div>
      )}
    </div>
  );
}
