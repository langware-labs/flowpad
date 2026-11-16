/**
 * One automation in the list, as one line: switch · IF <when> → THEN <what> · Run now.
 *
 * The line IS the rule; its description and its facts (where it runs, its last runs) live on its page —
 * hover shows the description. Clicking anywhere but the switch and the button opens the automation
 * (URL-first: the click only navigates).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import type { AutomationSummary } from '@sdk';
import { AlertTriangle, Play } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@src/components/ui/button';
import { Switch } from '@src/components/ui/switch';
import { cn } from '@src/lib/utils';
import { sentenceOf, useAutomationWords } from './automation-words';
import { IfThenLine } from './IfThenLine';

export interface AutomationRowProps {
  automation: AutomationSummary;
  onOpen: () => void;
  onToggle: (enabled: boolean) => void;
  onRunOnce: () => void;
  busy?: boolean;
  /** The owning project's chip, for a row shown outside its project. */
  project?: ReactNode;
}

/** The switch is the person's on every rule but Flowpad's own -- and on Flowpad's own it ships off. */
export const canSwitch = (a: Pick<AutomationSummary, 'read_only' | 'switchable'>) => a.switchable ?? !a.read_only;

export function AutomationRow({ automation: a, onOpen, onToggle, onRunOnce, busy, project }: AutomationRowProps) {
  const { t } = useLingui();
  const sentence = sentenceOf(useAutomationWords(), a.when, a.then);
  return (
    <LineShell
      testId={`automation-row-${a.id}`}
      id={a.id}
      title={a.description || a.name}
      on={a.enabled}
      onOpen={onOpen}
      toggle={
        <Switch
          checked={a.enabled}
          disabled={busy || !canSwitch(a)}
          onCheckedChange={onToggle}
          aria-label={a.enabled ? t`Turn ${a.name} off` : t`Turn ${a.name} on`}
          data-testid={`automation-toggle-${a.id}`}
        />
      }
      action={
        <RunNow
          busy={busy}
          onClick={onRunOnce}
          testId={`automation-run-once-${a.id}`}
          title={t`Run it once now, even if it is off. It shows up in Runs as a test.`}
        />
      }
    >
      <IfThenLine when={sentence.when} then={sentence.then} />
      <Life automation={a} />
      {project}
      <Problem automation={a} />
    </LineShell>
  );
}

/** Where the rule stands in its own life: "ran 2 of 4 · until 08:39" while it runs, "Done · ran 4" once it ended. */
function Life({ automation: a }: { automation: AutomationSummary }) {
  const { t, i18n } = useLingui();
  const runs = a.fires ?? 0;
  const until = a.until ? new Intl.DateTimeFormat(i18n.locale || undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(a.until)) : '';
  let text = '';
  if (a.status === 'done') text = t`Done · ran ${runs}`;
  else if (a.status === 'expired') text = t`Ended · ran ${runs}`;
  else if (a.status === 'cancelled') text = t`Cancelled · ran ${runs}`;
  else if (a.max_runs) text = until ? t`ran ${runs} of ${a.max_runs} · until ${until}` : t`ran ${runs} of ${a.max_runs}`;
  else if (until) text = t`ran ${runs} · until ${until}`;
  if (!text) return null;
  const ended = a.status === 'done' || a.status === 'expired' || a.status === 'cancelled';
  return (
    <span
      data-testid={`automation-life-${a.id}`}
      data-status={a.status}
      className={`shrink-0 whitespace-nowrap text-xs tabular-nums ${ended ? 'text-muted-foreground' : 'text-foreground/80'}`}
    >
      {text}
    </span>
  );
}

/** One warning glyph, its reason on hover — a rule that needs attention, or failed lately. */
function Problem({ automation: a }: { automation: AutomationSummary }) {
  const { t } = useLingui();
  const problem = a.then.find((p) => p.problem)?.problem;
  const failing = a.recent_failures > 0 && a.recent_runs > 0;
  if (!problem && !failing) return null;
  return (
    <span title={problem || t`${a.recent_failures} of the last ${a.recent_runs} runs failed`} data-testid={`automation-problem-${a.id}`}>
      <AlertTriangle className="size-3.5 text-amber-500" aria-hidden />
    </span>
  );
}

/** The line every automation and package is: [toggle] [content] [action], the whole line opens it. */
export function LineShell({
  testId,
  id,
  title,
  on,
  onOpen,
  toggle,
  action,
  children,
}: {
  testId: string;
  id?: string;
  title?: string;
  on: boolean;
  onOpen?: () => void;
  toggle?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  const stop = { onClick: (e: { stopPropagation: () => void }) => e.stopPropagation(), onKeyDown: (e: { stopPropagation: () => void }) => e.stopPropagation() };
  return (
    <div
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      data-testid={testId}
      data-automation-id={id}
      title={title}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (onOpen && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        'group grid grid-cols-[2.25rem_minmax(0,1fr)_auto] items-center gap-x-4 border-t border-border px-4 py-2 focus-visible:outline-none',
        onOpen && 'cursor-pointer hover:bg-accent/50 focus-visible:bg-accent/50',
        !on && 'opacity-70',
      )}
    >
      <div {...stop}>{toggle}</div>
      <div className="flex min-w-0 items-center gap-2">{children}</div>
      <div {...stop}>{action}</div>
    </div>
  );
}

export function RunNow({ busy, onClick, testId, title }: { busy?: boolean; onClick: () => void; testId: string; title: string }) {
  return (
    <Button variant="ghost" size="sm" className="gap-1" disabled={busy} onClick={onClick} data-testid={testId} title={title}>
      <Play className="size-3.5" aria-hidden />
      <Trans>Run now</Trans>
    </Button>
  );
}
