import { Trans } from '@lingui/react/macro';
import { ExternalLink } from 'lucide-react';
import { AgenticProcess, ExitCode, TypeId, type CliResult } from '@sdk';
import type { ActivityProgressSpec } from '@sdk/activity';

import { Button } from '@src/components/ui/button';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useEntity } from '@src/hooks/entity-hooks';

import { LIVE_STATE, type WizardStepDoc } from './wizard-doc';
import type { WizardStepAnswer } from './useWizardRun';

function Stream({ label, text }: { label: string; text: string }) {
  if (!text) return null;
  return (
    <div className="mt-1">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/50 p-2 font-mono text-[11px]">
        {text}
      </pre>
    </div>
  );
}

/** One command, with both streams: the step's own call, or the completion
 *  check that decided its verdict. */
function CommandRow({ role, run }: { role: 'call' | 'check'; run: CliResult }) {
  // The verdict is ON the answer — re-deriving it from `returncode` here spelled
  // the backend's rule a second time, and the two readers of one answer drifted.
  const failed = run.exit_code !== ExitCode.OK && run.exit_code !== ExitCode.NOT_APPLICABLE;
  return (
    <li className="border-t border-border/60 py-2 first:border-t-0" data-testid={`wizard-probe-${role}`}>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
          {role === 'check' ? <Trans>check</Trans> : <Trans>call</Trans>}
        </span>
        {/* The RESOLVED command — what actually ran on this machine. */}
        <code className="flex-1 break-all font-mono text-xs">{run.command}</code>
        {run.timed_out ? (
          <span className="font-mono text-xs text-destructive">
            <Trans>timed out</Trans>
          </span>
        ) : (
          <span className={`font-mono text-xs ${failed ? 'text-destructive' : 'text-muted-foreground'}`}>
            {run.returncode ?? '—'}
          </span>
        )}
        {run.duration_s ? (
          <span className="font-mono text-[11px] text-muted-foreground/70">
            {run.duration_s.toFixed(2)}s
          </span>
        ) : null}
      </div>
      <Stream label="stdout" text={run.stdout ?? ''} />
      <Stream label="stderr" text={run.stderr ?? ''} />
    </li>
  );
}

/**
 * What ONE step actually did.
 *
 * A step is now a single invocation — `kind` · `ref` · `args` — so one panel
 * serves all three kinds rather than the previous split between a command step
 * and an agentic one. What differs between them is what the answer CARRIES, and
 * each part renders only when it is there: the command an op ran and the check
 * that judged it, the value it returned, the transcript of the process that ran
 * it (its `executor`). That is why a `compute` step
 * that ran no shell no longer reads as "this step ran no commands" — the header
 * says what it invoked, which is the thing the old panel could not say.
 */
export function WizardStepInspector({
  outcome,
  step,
  live,
}: {
  outcome: WizardStepAnswer | null;
  step?: WizardStepDoc;
  live?: ActivityProgressSpec | null;
}) {
  const { navigation } = useDockNavigation();
  // The process exists only once the step settled and named its executor;
  // while it runs, the live activity child is the only channel there is.
  const executor = outcome?.executor ?? '';
  const { data: process } = useEntity<AgenticProcess>(
    executor.startsWith(`${AgenticProcess.type}${TypeId.DELIMITER}`) ? new TypeId(executor) : null,
  );
  const call = outcome?.command ? (outcome as CliResult) : null;
  const check = outcome?.check ?? null;
  const args = Object.entries(step?.args ?? {});

  if (!step && !outcome) {
    return (
      <p className="text-xs text-muted-foreground">
        <Trans>This step has not run.</Trans>
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid="wizard-step-inspector">
      {step ? (
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
            {step.kind ?? 'compute'}
          </span>
          <code className="font-mono text-xs">{step.ref || '—'}</code>
          {live ? (
            <span className="font-mono text-[11px] text-muted-foreground" data-testid="wizard-step-live">
              {live.current || LIVE_STATE[live.state]?.label || live.state}
            </span>
          ) : null}
        </div>
      ) : null}

      {args.length > 0 ? (
        <ul className="flex flex-col" data-testid="wizard-step-args">
          {args.map(([key, value]) => (
            <li key={key} className="flex gap-2 font-mono text-[11px] text-muted-foreground">
              <span>{key}</span>
              <span className="text-muted-foreground/70">←</span>
              <span className="break-all">{value}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {call || check ? (
        <ul className="rounded border border-border/60 px-2" data-testid="wizard-probes">
          {call ? <CommandRow role="call" run={call} /> : null}
          {check ? <CommandRow role="check" run={check} /> : null}
        </ul>
      ) : null}

      {/* The RETURNED VALUE. Served only by `run-detail`, so it lands when the
          panel fetches. */}
      {outcome?.value != null ? (
        <div data-testid="wizard-step-result">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
            <Trans>Returned</Trans>
          </div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/50 p-2 font-mono text-[11px]">
            {typeof outcome.value === 'string' ? outcome.value : JSON.stringify(outcome.value, null, 2)}
          </pre>
        </div>
      ) : null}

      {outcome?.text ? <Stream label="reply" text={outcome.text} /> : null}

      {outcome?.detail ? <p className="text-xs text-muted-foreground">{outcome.detail}</p> : null}

      {!outcome ? (
        <p className="text-xs text-muted-foreground" data-testid="wizard-step-not-run">
          <Trans>This step has not run.</Trans>
        </p>
      ) : null}

      {/* The transcript is the account of what an agent actually did, and it
          already has a viewer. */}
      {process ? (
        <div>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 gap-1 px-1.5 text-[11px]"
            data-testid="wizard-step-transcript"
            onClick={() => navigation.openDock(process.transcriptDockPointer)}
          >
            <ExternalLink className="h-3 w-3" />
            <Trans>Open transcript</Trans>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
