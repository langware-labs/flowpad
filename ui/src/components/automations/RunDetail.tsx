/**
 * One run, answering three questions in order: why did it run, what did it do,
 * and — if it failed — what broke and how to fix it. Then "Run again with this
 * event", which replays the stored cause as a test run.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import type { AutomationRun } from '@sdk';
import { ExternalLink, RotateCcw, Settings2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@src/components/ui/button';
import { useAutomationRun, useRunOnce } from '@src/hooks/automations/useAutomations';
import { errorMessage } from '@src/lib/error-message';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useAutomationWords } from './automation-words';
import { RunStatusPill } from './RunStatusPill';

export function RunDetail({ runId, fallback }: { runId: string; fallback?: AutomationRun | null }) {
  const { t } = useLingui();
  const words = useAutomationWords();
  const { navigation } = useDockNavigation();
  // A polling list that already holds this run is its source; ask only when it does not.
  const { data, error } = useAutomationRun(runId, { enabled: !fallback });
  const run = fallback ?? data ?? null;
  const replay = useRunOnce();
  const [raw, setRaw] = useState(false);

  if (error && !run) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        {errorMessage(error, t`That run is no longer in the history.`)}
      </p>
    );
  }
  if (!run)
    return (
      <p className="p-6 text-sm text-muted-foreground">
        <Trans>Loading…</Trans>
      </p>
    );

  const canReplay = !!run.trigger_id && run.kind === 'event' && !!run.cause_tag;
  // The agent run's own page in the run history — its output, its transcript.
  const openProcess = () =>
    run.agentic_process_id && navigation.openDock(DockPointer.forProcessRuns({ run: run.agentic_process_id }));
  const openAutomation = () =>
    run.trigger_id && navigation.openDock(DockPointer.forAutomations({ trigger: run.trigger_id }));

  return (
    <div className="flex flex-col gap-5 p-5" data-testid="run-detail" data-status={run.status}>
      <header className="flex flex-wrap items-center gap-3">
        <RunStatusPill status={run.status} />
        <button
          type="button"
          className="font-medium hover:underline"
          onClick={openAutomation}
          data-testid="run-detail-automation"
        >
          {run.automation_name}
        </button>
        <span className="text-xs text-muted-foreground">
          {words.at(run.ts)}
          {run.duration_ms != null && ` · ${words.duration(run.duration_ms)}`}
          {run.is_test && (
            <>
              {' · '}
              <Trans>test run</Trans>
            </>
          )}
        </span>
        <span className="flex-1" />
        {canReplay && (
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            disabled={replay.isPending}
            data-testid="run-replay"
            onClick={() =>
              replay.mutate({
                triggerId: run.trigger_id as string,
                event: {
                  tag: run.cause_tag as string,
                  target: run.cause_target ?? undefined,
                  data: (run.cause_data as Record<string, unknown>) ?? {},
                },
              })
            }
          >
            <RotateCcw className="size-3.5" aria-hidden />
            <Trans>Run again with this event</Trans>
          </Button>
        )}
      </header>

      {run.status === 'failed' && (
        <section
          className="rounded-md border border-red-500/60 bg-red-500/10 px-3 py-2 text-sm"
          data-testid="run-detail-error"
        >
          <div className="font-medium">
            <Trans>What went wrong</Trans>
          </div>
          <p className="mt-1 whitespace-pre-wrap break-words">{run.error || t`It failed without saying why.`}</p>
          {run.trigger_id && (
            <button
              type="button"
              onClick={openAutomation}
              className="mt-2 inline-flex items-center gap-1 text-xs underline-offset-2 hover:underline"
            >
              <Settings2 className="size-3.5" aria-hidden />
              <Trans>Open the automation to fix it</Trans>
            </button>
          )}
        </section>
      )}
      {replay.isSuccess && (
        <p className="rounded border border-emerald-500/50 bg-emerald-500/10 px-2 py-1.5 text-xs">
          <Trans>Started again as a test run.</Trans>
        </p>
      )}

      <section>
        <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <Trans>Why it ran</Trans>
        </h4>
        <p className="text-sm">{words.why(run)}</p>
        {(run.cause_tag || run.cause_data != null || run.changed_path) && (
          <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
            {run.cause_tag && (
              <>
                <dt className="text-muted-foreground">
                  <Trans>Event</Trans>
                </dt>
                <dd>
                  <code className="font-mono">{run.cause_tag}</code>
                </dd>
              </>
            )}
            {run.cause_target && (
              <>
                <dt className="text-muted-foreground">
                  <Trans>About</Trans>
                </dt>
                <dd>
                  <code className="break-all font-mono">{run.cause_target}</code>
                </dd>
              </>
            )}
            {run.changed_path && (
              <>
                <dt className="text-muted-foreground">
                  <Trans>File</Trans>
                </dt>
                <dd>
                  <code className="break-all font-mono">{run.changed_path}</code>
                </dd>
              </>
            )}
          </dl>
        )}
        {run.cause_data != null && (
          <pre
            className="mt-2 max-h-48 overflow-auto rounded border border-border bg-muted/40 p-2 font-mono text-[11px]"
            data-testid="run-detail-cause"
          >
            {JSON.stringify(run.cause_data, null, 2)}
          </pre>
        )}
      </section>

      <section>
        <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <Trans>What it did</Trans>
        </h4>
        {run.status === 'skipped' ? (
          <p className="text-sm text-muted-foreground">
            <Trans>Nothing. It was skipped, for the reason above.</Trans>
          </p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {run.actions.length === 0 && (
              <li className="text-muted-foreground">
                <Trans>No steps; it started the workflows that listen for it.</Trans>
              </li>
            )}
            {run.actions.map((a, i) => (
              <li key={i} className="flex items-center gap-2">
                <code className="rounded bg-muted px-1.5 font-mono text-xs">{a}</code>
              </li>
            ))}
            {run.agentic_process_id && (
              <li>
                <button
                  type="button"
                  onClick={openProcess}
                  className="inline-flex items-center gap-1 text-sm underline-offset-2 hover:underline"
                  data-testid="run-detail-open-process"
                >
                  <ExternalLink className="size-3.5" aria-hidden />
                  <Trans>Open the agent run</Trans>
                  {run.process_status && <span className="text-xs text-muted-foreground">({run.process_status})</span>}
                </button>
              </li>
            )}
          </ul>
        )}
      </section>

      <div>
        <button
          type="button"
          onClick={() => setRaw((r) => !r)}
          className="text-xs text-muted-foreground hover:text-foreground"
          data-testid="run-detail-raw-toggle"
        >
          {raw ? <Trans>Hide the raw record</Trans> : <Trans>Show the raw record</Trans>}
        </button>
        {raw && (
          <pre className="mt-2 max-h-72 overflow-auto rounded border border-border bg-muted/40 p-2 font-mono text-[11px]">
            {JSON.stringify(run, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}
