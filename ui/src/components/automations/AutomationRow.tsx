/**
 * One automation in the list: switch · sentence · last result · next run · action.
 *
 * The row reads as the rule: "Every weekday at 09:00 → run Chief of Staff". The
 * name sits under it, smaller — the sentence is what the rule IS, the name is a
 * label someone gave it. Clicking anywhere but the switch and the button opens
 * the automation (URL-first: the click only navigates).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import type { AutomationSummary } from '@sdk';
import { AlertTriangle, ArrowRight, FlaskConical, Play } from 'lucide-react';
import { Button } from '@src/components/ui/button';
import { Switch } from '@src/components/ui/switch';
import { cn } from '@src/lib/utils';
import { sentenceOf, useAutomationWords } from './automation-words';
import { RunStatusPill } from './RunStatusPill';

export interface AutomationRowProps {
  automation: AutomationSummary;
  onOpen: () => void;
  onToggle: (enabled: boolean) => void;
  onRunOnce: () => void;
  busy?: boolean;
}

export function AutomationRow({ automation: a, onOpen, onToggle, onRunOnce, busy }: AutomationRowProps) {
  const { t } = useLingui();
  const words = useAutomationWords();
  const sentence = sentenceOf(words, a.when, a.then);
  const problem = a.then.find((p) => p.problem)?.problem;
  const flaky = a.recent_failures > 0 && a.recent_runs > 0;

  return (
    <div
      role="button"
      tabIndex={0}
      data-testid={`automation-row-${a.id}`}
      data-automation-id={a.id}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        'group grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 border-t border-border px-4 py-3 hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none md:grid-cols-[auto_minmax(0,1fr)_11rem_10rem_auto]',
        !a.enabled && 'opacity-70',
      )}
    >
      <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <Switch
          checked={a.enabled}
          disabled={busy || a.read_only}
          onCheckedChange={onToggle}
          aria-label={a.enabled ? t`Turn ${a.name} off` : t`Turn ${a.name} on`}
          data-testid={`automation-toggle-${a.id}`}
        />
      </div>

      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-sm">
          <span className="font-medium">{sentence.when}</span>
          <ArrowRight className="size-3.5 shrink-0 self-center text-muted-foreground" aria-hidden />
          <span className="min-w-0 break-words">{sentence.then}</span>
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span className="truncate">{a.name}</span>
          {problem && (
            <span
              className="inline-flex items-center gap-1 rounded border border-amber-500/50 bg-amber-500/10 px-1.5 text-foreground"
              title={problem}
            >
              <AlertTriangle className="size-3" aria-hidden />
              <Trans>Needs attention</Trans>
            </span>
          )}
        </div>
      </div>

      <div className="hidden text-xs md:block" data-testid={`automation-last-${a.id}`}>
        {a.last_run ? (
          <div className="flex flex-col items-start gap-0.5">
            <RunStatusPill status={a.last_run.status} />
            <span className="text-muted-foreground">
              {words.at(a.last_run.ts)}
              {flaky && a.recent_runs > 1 && (
                <>
                  {' · '}
                  <Trans>
                    {a.recent_failures} of last {a.recent_runs} failed
                  </Trans>
                </>
              )}
            </span>
          </div>
        ) : (
          <span className="text-muted-foreground">
            <Trans>Never ran</Trans>
          </span>
        )}
      </div>

      <div className="hidden text-xs md:block">
        {!a.tested && !a.read_only ? (
          <span
            data-testid={`automation-untested-${a.id}`}
            className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-muted-foreground"
          >
            <FlaskConical className="size-3" aria-hidden />
            <Trans>Not tested yet</Trans>
          </span>
        ) : a.enabled && a.next_run ? (
          <span className="text-muted-foreground">
            <Trans>Next: {words.at(a.next_run)}</Trans>
          </span>
        ) : !a.enabled ? (
          <span className="text-muted-foreground">
            <Trans>Off</Trans>
          </span>
        ) : null}
      </div>

      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        className="col-start-3 row-start-1 md:col-start-auto"
      >
        <Button
          variant="ghost"
          size="sm"
          className="gap-1"
          disabled={busy}
          onClick={onRunOnce}
          data-testid={`automation-run-once-${a.id}`}
          title={t`Run it once now, even if it is off. It shows up in Runs as a test.`}
        >
          <Play className="size-3.5" aria-hidden />
          <Trans>Run now</Trans>
        </Button>
      </div>
    </div>
  );
}
