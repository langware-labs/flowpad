import { Trans } from '@lingui/react/macro';
import { ExternalLink } from 'lucide-react';
import { AgenticProcess, TypeId, type WizardStepOutcome, type WizardStepProbe } from '@sdk';
import type { ActivityProgressSpec } from '@sdk/activity';

import { Button } from '@src/components/ui/button';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useEntity } from '@src/hooks/entity-hooks';

import { actionKindOf, LIVE_STATE, type WizardStepDoc } from './wizard-doc';

/** Phase → the plain-language question that phase answers. The vocabulary is
 *  the form's ("Skip if" / "Runs" / "Proved by"), so the debugger and the editor
 *  name the same three commands the same way. */
const PHASE_LABEL: Record<string, string> = {
  precondition: 'Skip if',
  action: 'Runs',
  verify: 'Proved by',
};

export function Stream({ label, text, truncated }: { label: string; text: string; truncated?: boolean }) {
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

function ProbeRow({ probe }: { probe: WizardStepProbe }) {
  const failed = probe.timed_out || (probe.returncode != null && probe.returncode !== 0);
  return (
    <li className="border-t border-border/60 py-2 first:border-t-0" data-testid={`wizard-probe-${probe.phase}`}>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
          {PHASE_LABEL[probe.phase] ?? probe.phase}
        </span>
        {/* The RESOLVED command — what actually ran on this machine, not the
            per-OS map the document declares. */}
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
 * What one step actually did — every command it ran, with both streams.
 *
 * A step runs up to THREE commands, which is why this is a list and why the
 * outcome's single `returncode` was never enough to debug from: it is the
 * action's, unless verify failed, in which case it is silently verify's.
 */
/**
 * What an AGENTIC step did.
 *
 * A process step runs no shell commands, so its probe list is empty and this
 * panel used to say "this step ran no commands" — true, and useless for the one
 * kind of step whose work is hardest to see.
 */
function AgenticStep({
  step,
  outcome,
  live,
}: {
  step: WizardStepDoc;
  outcome: WizardStepOutcome | null;
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

  return (
    <div className="flex flex-col gap-2" data-testid="wizard-process-step">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
          <Trans>Agent</Trans>
        </span>
        <code className="font-mono text-xs">{step.process?.agent || '—'}</code>
        {live ? (
          <span className="font-mono text-[11px] text-muted-foreground" data-testid="wizard-process-live">
            {live.current || LIVE_STATE[live.state]?.label || live.state}
          </span>
        ) : null}
      </div>

      <Stream label="prompt" text={step.process?.prompt ?? ''} />

      {/* The RETURNED VALUE — the reason this step type was unreadable. Served
          only by `run-detail`, so it lands when the panel fetches. */}
      {outcome?.output ? (
        <div data-testid="wizard-process-result">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
            <Trans>Returned {outcome.output}</Trans>
          </div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/50 p-2 font-mono text-[11px]">
            {typeof outcome.result === 'string' ? outcome.result : JSON.stringify(outcome.result, null, 2)}
          </pre>
        </div>
      ) : null}

      {outcome?.message ? <p className="text-xs text-muted-foreground">{outcome.message}</p> : null}

      {/* `process_id` has ridden the wire since this panel's first version and
          was rendered nowhere. The transcript is the account of what the agent
          actually did, and it already has a viewer. */}
      {process ? (
        <div>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 gap-1 px-1.5 text-[11px]"
            data-testid="wizard-process-transcript"
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

export function WizardStepInspector({
  outcome,
  step,
  live,
}: {
  outcome: WizardStepOutcome | null;
  step?: WizardStepDoc;
  live?: ActivityProgressSpec | null;
}) {
  if (step && actionKindOf(step) === 'process') {
    return <AgenticStep step={step} outcome={outcome} live={live} />;
  }
  if (!outcome) {
    return (
      <p className="text-xs text-muted-foreground">
        <Trans>This step has not run.</Trans>
      </p>
    );
  }
  const probes = outcome.probes ?? [];
  if (!probes.length) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="wizard-no-probes">
        {outcome.message ? (
          outcome.message
        ) : (
          /* An input step runs no commands, and a run recorded before probes
             existed has none either — both are legitimately empty. */
          <Trans>This step ran no commands.</Trans>
        )}
      </p>
    );
  }
  return (
    <ul className="rounded border border-border/60 px-2" data-testid="wizard-probes">
      {probes.map((probe, i) => (
        <ProbeRow key={i} probe={probe} />
      ))}
    </ul>
  );
}
