import { Trans } from '@lingui/react/macro';
import type { WizardStepOutcome, WizardStepProbe } from '@sdk';

/** Phase → the plain-language question that phase answers. The vocabulary is
 *  the form's ("Skip if" / "Runs" / "Proved by"), so the debugger and the editor
 *  name the same three commands the same way. */
const PHASE_LABEL: Record<string, string> = {
  precondition: 'Skip if',
  action: 'Runs',
  verify: 'Proved by',
};

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
export function WizardStepInspector({ outcome }: { outcome: WizardStepOutcome | null }) {
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
