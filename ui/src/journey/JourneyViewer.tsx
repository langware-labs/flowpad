import { Journey, JourneyJournal, type JourneyStep } from '@sdk';
import { Check, Circle, Clock, Compass, History, Loader2, Play, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@src/components/ui/button';
import { useIsAdvanced } from '@src/contexts/view-mode-context';
import { cn } from '@src/lib/utils';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { clearJourneyDismissed } from './journey-dismissed';
import { useActiveJournal, useBusyRun, useJourneySteps } from './use-journey';

const NO_DONE_IDS: ReadonlySet<string> = new Set<string>();

const STATUS_LABEL: Record<string, string> = {
  new: 'Not started',
  launched: 'In progress',
  complete: 'Completed',
  restarted: 'Restarted',
};

/**
 * The asset editor for a Journey — what you get when you click one in the asset
 * browser (instead of the old markdown-editor fallback). Shows the journey's
 * steps with your progress, and the controls that drive it: Start/Continue
 * (shows the journey on the URL), Restart, and — in Advanced view only — a
 * History list that can resume a previous journal.
 */
export function JourneyViewer({ journey }: { journey: Journey }) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const isAdvanced = useIsAdvanced();
  const { graph, loading } = useJourneySteps(journey);
  const { journal: activeJournal, refresh } = useActiveJournal();
  const { busy, run } = useBusyRun(refresh);
  const [history, setHistory] = useState<JourneyJournal[] | null>(null);

  const journal = activeJournal?.journey_id === journey.id ? activeJournal : null;
  const cursorIndex = journal?.indexIn(graph) ?? -1;
  const doneIds = journal?.doneNodeIds() ?? NO_DONE_IDS;
  const complete = !!journal?.isComplete;

  const show = () => {
    clearJourneyDismissed();
    navigation.showJourney(journey.id);
  };

  if (loading && graph.isEmpty) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> <Trans>Loading journey…</Trans>
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col gap-6 overflow-y-auto p-8">
      <header className="flex items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Compass className="h-6 w-6" />
        </div>
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">{journey.name}</h1>
          <p className="text-sm text-muted-foreground" data-testid="journey-viewer-status">
            {graph.length} steps
            {journal ? ` · ${STATUS_LABEL[journal.status ?? ''] ?? journal.status}` : ' · not started'}
            {journal && !complete ? ` · ${journal.steps_left ?? 0} left` : ''}
          </p>
        </div>
      </header>

      <ol className="flex flex-col gap-1">
        {graph.sections.map((section) => {
          const renderStep = (step: JourneyStep, i: number, indent: boolean) => {
            const done = complete || doneIds.has(step.node_id);
            const current = !complete && i === cursorIndex;
            return (
              <li
                key={step.node_id}
                className={cn(
                  'flex items-start gap-3 rounded-lg px-3 py-2.5',
                  current && 'bg-primary/5 ring-1 ring-primary/30',
                  indent && 'ms-6',
                )}
              >
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
                  {done ? (
                    <Check className="h-4 w-4 text-emerald-500" />
                  ) : current ? (
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
                      {i + 1}
                    </span>
                  ) : (
                    <Circle className="h-4 w-4 text-muted-foreground/40" />
                  )}
                </span>
                <div className="min-w-0">
                  <div
                    className={cn(
                      'text-sm font-medium',
                      current ? 'text-primary' : done ? 'text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    {step.name}
                  </div>
                  {step.status_line && <div className="text-xs text-muted-foreground">{step.status_line}</div>}
                </div>
              </li>
            );
          };

          if (section.group === null) {
            return section.indices.map((i) => renderStep(graph.steps[i], i, false));
          }
          return (
            <li key={`group:${section.group}:${section.indices[0]}`} data-group={section.group}>
              <div className="px-3 pb-0.5 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {section.group}
              </div>
              <ol className="flex flex-col gap-1">{section.indices.map((i) => renderStep(graph.steps[i], i, true))}</ol>
            </li>
          );
        })}
      </ol>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          disabled={busy}
          onClick={() => (journal ? show() : run(() => journey.launch(), show))}
          className="gap-2"
          data-testid="journey-start"
        >
          <Play className="h-4 w-4" />
          {complete ? (
            <Trans>Show journey</Trans>
          ) : journal ? (
            <Trans>Continue journey</Trans>
          ) : (
            <Trans>Start journey</Trans>
          )}
        </Button>

        {journal && (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => run(() => journey.restart(), show)}
            className="gap-2"
            data-testid="journey-restart"
          >
            <RotateCcw className="h-4 w-4" />
            <Trans>Restart</Trans>
          </Button>
        )}

        {/* Advanced-only: previous runs, resumable. */}
        {isAdvanced && (
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => (history === null ? run(async () => setHistory(await journey.history())) : setHistory(null))}
            className="gap-2 text-muted-foreground"
            data-testid="journey-history"
          >
            <History className="h-4 w-4" />
            <Trans>History</Trans>
          </Button>
        )}
      </div>

      {isAdvanced && history !== null && (
        <section className="rounded-lg border border-border" data-testid="journey-history-list">
          <h2 className="border-b border-border px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Trans>Previous runs</Trans>
          </h2>
          {history.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">
              <Trans>No runs yet.</Trans>
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {history.map((h) => (
                <li key={h.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="w-24 shrink-0 font-medium">{STATUS_LABEL[h.status ?? ''] ?? h.status}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    {h.entries?.length ?? 0} of {h.total_steps ?? graph.length} done
                    {h.cursor ? ` · at ${h.cursor}` : ''}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy || h.isActive}
                    title={t`Resume this run`}
                    onClick={() =>
                      run(
                        () => Journey.resume(h.id),
                        () => {
                          setHistory(null);
                          show();
                        },
                      )
                    }
                    className="h-7 px-2 text-xs"
                    data-testid="journey-history-resume"
                  >
                    {h.isActive ? <Trans>Current</Trans> : <Trans>Resume</Trans>}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

export default JourneyViewer;
