import { Trans } from '@lingui/react/macro';
import { ExternalLink } from 'lucide-react';
import { AgenticProcess, TypeId, type WizardStepOutcome, type WizardStepProbe } from '@sdk';
import type { ActivityProgressSpec } from '@sdk/activity';

import { Button } from '@src/components/ui/button';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useEntity } from '@src/hooks/entity-hooks';

import { LIVE_STATE, type WizardStepDoc } from './wizard-doc';

function Stream({ label, text, truncated }: { label: string; text: string; truncated?: boolean }) {
  if (!text) return null;
  return (
    <div className="mt-1">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div>
      {truncated && (
        <div className="text-[11px] text-muted-foreground/70">
          {/* Says which END survived, because that changes how the text reads. */}
          <Trans>earlier output dropped — this is the tail</Trans>
        </div>
      )}
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/50 p-2 font-mono text-[11px]">
        {text}
      </pre>
    </div>
  );
}

/** One command the step's op ran, with both streams. The phase is printed as
 *  the backend recorded it — this panel does not own that vocabulary. */
function ProbeRow({ probe }: { probe: WizardStepProbe }) {
  const failed = probe.timed_out || (probe.returncode != null && probe.returncode !== 0);
  return (
    <li className="border-t border-border/60 py-2 first:border-t-0" data-testid={`wizard-probe-${probe.phase}`}>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
          {probe.phase}
        </span>
        {/* The RESOLVED command — what actually ran on this machine. */}
        <code className="flex-1 break-all font-mono text-xs">{probe.command}</code>
        {probe.timed_out ? (
          <span className="font-mono text-xs text-destructive">
            <Trans>timed out</Trans>
          </span>
        ) : (
          <span className={`font-mono text-xs ${failed ? 'text-destructive' : 'text-muted-foreground'}`}>
            {probe.returncode ?? '—'}
          </span>
        )}
        {probe.duration_s != null && (
          <span className="font-mono text-[11px] text-muted-foreground/70">
            {probe.duration_s.toFixed(2)}s
          </span>
        )}
      </div>
      <Stream label="stdout" text={probe.stdout ?? ''} truncated={probe.truncated} />
      <Stream label="stderr" text={probe.stderr ?? ''} truncated={probe.truncated} />
    </li>
  );
}

/**
 * What ONE step actually did.
 *
 * A step is now a single invocation — `kind` · `ref` · `args` — so one panel
 * serves all three kinds rather than the previous split between a command step
 * and an agentic one. What differs between them is what the run RECORDED, and
 * each part renders only when it is there: the commands an op ran, the value it
 * returned, the transcript of an agent it spawned. That is why a `compute` step
 * that ran no shell no longer reads as "this step ran no commands" — the header
 * says what it invoked, which is the thing the old panel could not say.
 */
export function WizardStepInspector({
  outcome,
  step,
  live,
}: {
  outcome: WizardStepOutcome | null;
  step?: WizardStepDoc;
  live?: ActivityProgressSpec | null;
}) {
  const { navigation } = useDockNavigation();
  const processId = outcome?.process_id ?? '';
  // The process entity exists only once the step settled and recorded its id;
  // while it runs, the live activity child is the only channel there is.
  // `null` until there is an id — the hook takes a TypeId, and a step that has
  // not run has no process to look up.
  const { data: process } = useEntity<AgenticProcess>(
    processId ? new TypeId(AgenticProcess.type, processId) : null,
  );
  const probes = outcome?.probes ?? [];
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

      {probes.length > 0 ? (
        <ul className="rounded border border-border/60 px-2" data-testid="wizard-probes">
          {probes.map((probe, i) => (
            <ProbeRow key={i} probe={probe} />
          ))}
        </ul>
      ) : null}

      {/* The RETURNED VALUE. Served only by `run-detail`, so it lands when the
          panel fetches. */}
      {outcome?.result != null ? (
        <div data-testid="wizard-step-result">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
            <Trans>Returned</Trans>
          </div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/50 p-2 font-mono text-[11px]">
            {typeof outcome.result === 'string' ? outcome.result : JSON.stringify(outcome.result, null, 2)}
          </pre>
        </div>
      ) : null}

      {outcome?.message ? <p className="text-xs text-muted-foreground">{outcome.message}</p> : null}

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
