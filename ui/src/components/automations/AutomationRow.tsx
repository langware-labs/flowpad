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
import { AlertTriangle, ArrowRight, FlaskConical, FolderOpen, Play } from 'lucide-react';
import { Button } from '@src/components/ui/button';
import { Switch } from '@src/components/ui/switch';
import { cn } from '@src/lib/utils';
import { sentenceOf, useAutomationWords } from './automation-words';
import { KindBadge } from './KindBadge';
import { useAutomationOpen } from './use-automation-open';
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
  const open = useAutomationOpen();

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
        'group grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-4 border-t border-border px-4 py-3 hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none',
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

      {/* Two lines, full width: the rule as a sentence, then one line of facts. */}
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-sm">
          <span className="font-medium">{sentence.when}</span>
          <ArrowRight className="size-3.5 shrink-0 self-center text-muted-foreground" aria-hidden />
          <span className="min-w-0 break-words">{sentence.then}</span>
        </div>
        {a.description && (
          <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground" title={a.description}>
            {a.description}
          </p>
        )}
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <KindBadge kind={a.kind} />
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              open.openDefinition(a);
            }}
            className="max-w-[16rem] truncate underline-offset-2 hover:text-foreground hover:underline"
            title={a.asset_ref ? t`Open its definition (trigger.json)` : t`Open this automation`}
            data-testid={`automation-name-${a.id}`}
          >
            {a.name}
          </button>
          {a.kind === 'file' && a.when.file?.path && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                open.browseWatched(a);
              }}
              className="inline-flex items-center gap-1 underline-offset-2 hover:text-foreground hover:underline"
              title={a.when.file.path}
              data-testid={`automation-browse-${a.id}`}
            >
              <FolderOpen className="size-3" aria-hidden />
              {a.when.file.is_folder ? <Trans>Browse folder</Trans> : <Trans>Open file</Trans>}
            </button>
          )}
          <span className="inline-flex items-center gap-1.5" data-testid={`automation-last-${a.id}`}>
            {a.last_run ? (
              <>
                <RunStatusPill status={a.last_run.status} />
                <span>{words.at(a.last_run.ts)}</span>
                {flaky && a.recent_runs > 1 && (
                  <span>
                    <Trans>
                      {a.recent_failures} of last {a.recent_runs} failed
                    </Trans>
                  </span>
                )}
              </>
            ) : (
              <Trans>Never ran</Trans>
            )}
          </span>
          {!a.tested && !a.read_only ? (
            <span
              data-testid={`automation-untested-${a.id}`}
              className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5"
            >
              <FlaskConical className="size-3" aria-hidden />
              <Trans>Not tested yet</Trans>
            </span>
          ) : a.enabled && a.next_run ? (
            <span>
              <Trans>Next: {words.at(a.next_run)}</Trans>
            </span>
          ) : !a.enabled ? (
            <span>
              <Trans>Off</Trans>
            </span>
          ) : null}
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

      <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
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
