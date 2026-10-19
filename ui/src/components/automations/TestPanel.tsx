/**
 * Test, always beside the builder. Two buttons that mean different things:
 *
 *  * **Check** — a dry run. Would it run, and what would it do? Nothing fires.
 *  * **Run once now** — really runs it, even while it is off, and shows up in
 *    Runs as a test. Needs the automation saved.
 *
 * For an event automation the panel offers recent REAL events to test with (the
 * last ones that matched, or the app's recent stream), refreshed while open — so
 * "wait for the next one" is just leaving the panel open.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import type { AutomationSample, AutomationTestEvent, ITrigger } from '@sdk';
import { CheckCircle2, Loader2, Play, Search, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@src/components/ui/button';
import { useAutomationCheck, useAutomationSamples, useRunOnce } from '@src/hooks/automations/useAutomations';
import { errorMessage } from '@src/lib/error-message';
import { cn } from '@src/lib/utils';
import { useAutomationWords } from './automation-words';

export interface TestPanelProps {
  /** Saved and unchanged: Check and Run use the saved automation. */
  triggerId: string | null;
  /** The builder's current fields — what Check reads when there are unsaved changes. */
  spec: Partial<ITrigger>;
  dirty: boolean;
  isEvent: boolean;
  /** Save first, then run. Resolves to the saved id. */
  onSaveFirst?: () => Promise<string | null>;
  onRunStarted?: () => void;
}

export function TestPanel({ triggerId, spec, dirty, isEvent, onSaveFirst, onRunStarted }: TestPanelProps) {
  const { t } = useLingui();
  const words = useAutomationWords();
  const check = useAutomationCheck();
  const runOnce = useRunOnce();
  const [picked, setPicked] = useState<AutomationSample | null>(null);
  const samples = useAutomationSamples({
    triggerId: isEvent && triggerId && !dirty ? triggerId : null,
    pattern: isEvent && (!triggerId || dirty) ? (spec.tag_pattern ?? '') : null,
    target: spec.tag_target ?? null,
  });
  const event: AutomationTestEvent | null = picked
    ? { tag: picked.tag, target: picked.target, data: picked.data }
    : null;

  const doCheck = () => check.mutate({ triggerId: !dirty ? triggerId : null, spec, event });

  const doRun = async () => {
    let id = !dirty ? triggerId : null;
    if (!id && onSaveFirst) id = await onSaveFirst();
    if (!id) return;
    runOnce.mutate({ triggerId: id, event }, { onSuccess: () => onRunStarted?.() });
  };

  const result = check.data;

  return (
    <aside
      className="flex flex-col gap-4 rounded-lg border border-border bg-muted/20 p-4"
      data-testid="automation-test-panel"
    >
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Trans>Test</Trans>
      </h3>

      {isEvent && (
        <div className="flex flex-col gap-1.5" data-testid="test-samples">
          <span className="text-xs text-muted-foreground">
            <Trans>Test with a recent event</Trans>
          </span>
          {(samples.data ?? []).length === 0 ? (
            <p className="rounded border border-dashed border-border px-2 py-2 text-xs text-muted-foreground">
              {samples.isFetching ? (
                <Trans>Looking for recent events…</Trans>
              ) : (
                <Trans>
                  No recent event like this yet. Leave this open and it appears when one happens, or test with a sample.
                </Trans>
              )}
            </p>
          ) : (
            (samples.data ?? []).map((s, i) => (
              <button
                key={s.id ?? i}
                type="button"
                data-testid={`test-sample-${i}`}
                aria-pressed={picked?.id === s.id}
                onClick={() => setPicked(picked?.id === s.id ? null : s)}
                className={cn(
                  'flex items-center gap-2 rounded border px-2 py-1.5 text-left text-xs',
                  picked?.id === s.id ? 'border-primary bg-primary/10' : 'border-border hover:bg-accent/40',
                )}
              >
                <span className="tabular-nums text-muted-foreground">{words.at(s.ts)}</span>
                <code className="min-w-0 flex-1 truncate font-mono">{s.tag}</code>
                <span className="truncate text-muted-foreground">{s.target}</span>
              </button>
            ))
          )}
          {!picked && (samples.data ?? []).length > 0 && (
            <span className="text-xs text-muted-foreground">
              <Trans>None picked: a sample event is used.</Trans>
            </span>
          )}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <Button
          variant="outline"
          className="justify-start gap-2"
          onClick={doCheck}
          disabled={check.isPending}
          data-testid="test-check"
        >
          {check.isPending ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Search className="size-4" aria-hidden />
          )}
          <span className="flex flex-col items-start leading-tight">
            <Trans>Check</Trans>
            <span className="text-[11px] font-normal text-muted-foreground">
              <Trans>Would it run, and what would it do? Nothing runs.</Trans>
            </span>
          </span>
        </Button>
        <Button
          variant="outline"
          className="h-auto justify-start gap-2 py-2"
          onClick={() => void doRun()}
          disabled={runOnce.isPending}
          data-testid="test-run-once"
        >
          {runOnce.isPending ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Play className="size-4" aria-hidden />
          )}
          <span className="flex flex-col items-start leading-tight">
            {dirty || !triggerId ? <Trans>Save and run once now</Trans> : <Trans>Run once now</Trans>}
            <span className="whitespace-normal text-left text-[11px] font-normal text-muted-foreground">
              <Trans>Really runs it, even while it is off. Shows in Runs as a test.</Trans>
            </span>
          </span>
        </Button>
      </div>

      {check.error && (
        <div className="rounded border border-red-500/60 bg-red-500/10 px-2 py-1.5 text-xs">
          {errorMessage(check.error, t`Check failed`)}
        </div>
      )}
      {runOnce.error && (
        <div
          className="rounded border border-red-500/60 bg-red-500/10 px-2 py-1.5 text-xs"
          data-testid="test-run-error"
        >
          {errorMessage(runOnce.error, t`Could not run it`)}
        </div>
      )}
      {runOnce.isSuccess && (
        <div
          className="rounded border border-emerald-500/50 bg-emerald-500/10 px-2 py-1.5 text-xs"
          data-testid="test-run-started"
        >
          <Trans>Started. Follow it under Runs.</Trans>
        </div>
      )}

      {result && (
        <div
          className={cn(
            'flex flex-col gap-1.5 rounded border px-3 py-2 text-xs',
            result.ok ? 'border-emerald-500/50' : 'border-amber-500/50 bg-amber-500/5',
          )}
          data-testid="test-check-result"
          data-ok={result.ok}
        >
          <div className="font-medium">
            {result.would_fire === false ? (
              <Trans>This event would not start it.</Trans>
            ) : result.ok ? (
              <Trans>Ready. It would run and do what is listed.</Trans>
            ) : (
              <Trans>Some things need attention.</Trans>
            )}
          </div>
          {result.findings.map((f, i) => (
            <div key={i} className="flex items-start gap-1.5" data-finding-ok={f.ok}>
              {f.ok ? (
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-600" aria-hidden />
              ) : (
                <XCircle className="mt-0.5 size-3.5 shrink-0 text-amber-600" aria-hidden />
              )}
              <span>{f.message}</span>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
