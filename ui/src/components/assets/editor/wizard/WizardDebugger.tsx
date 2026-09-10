import { useMemo, useState } from 'react';
import { Trans } from '@lingui/react/macro';
import { Loader2 } from 'lucide-react';
import type { WizardStepOutcome } from '@sdk';

import { WizardStepInspector } from './WizardStepInspector';
import { LIVE_STATE, type WizardStepDoc } from './wizard-doc';
import type { WizardRunStep } from './useWizardRun';

/**
 * What the run did, step by step, with the commands and their output.
 *
 * Advanced-mode only, and deliberately POST-HOC rather than a stepper: there is
 * no single-step execution verb, because stepping would change what a run means
 * (the lock, resume, what a partial run records). What it offers instead is the
 * two things a person actually needs when a wizard misbehaves — every command
 * with its real output, and a way to start over.
 */
export function WizardDebugger({
  steps,
  orphaned,
  loadingDetail,
  onExpand,
  docSteps = [],
}: {
  steps: WizardRunStep[];
  orphaned: WizardStepOutcome[];
  loadingDetail: boolean;
  onExpand: () => void;
  /** The DOCUMENT's steps, so the inspector can tell an agentic step from a
   *  command one — the outcome alone cannot say which it was. */
  docSteps?: WizardStepDoc[];
}) {
  const [open, setOpen] = useState<string | null>(null);
  const docById = useMemo(() => new Map(docSteps.map((s) => [s.id, s])), [docSteps]);

  const toggle = (stepId: string) => {
    const next = open === stepId ? null : stepId;
    setOpen(next);
    // Probes are fetched on the EXPAND gesture, not on advanced mode — the
    // gate is a skin, so keying the fetch off `isAdvanced` would fetch for
    // every wizard anyone opens in Advanced.
    if (next) onExpand();
  };

  return (
    <section className="flex h-full flex-col overflow-y-auto p-3" data-testid="wizard-debugger">
      {loadingDetail && (
        <Loader2 className="mb-2 h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
      )}

      {steps.length === 0 && (
        <p className="text-xs text-muted-foreground">
          <Trans>This wizard declares no steps.</Trans>
        </p>
      )}

      <ul className="flex flex-col">
        {steps.map(({ step_id, live: liveNode, outcome }) => {
          const status = liveNode ? (LIVE_STATE[liveNode.state]?.label ?? liveNode.state) : outcome?.status;
          return (
            <li key={step_id} className="border-t border-border/60 py-1.5 first:border-t-0">
              <button
                type="button"
                className="flex w-full items-baseline gap-2 text-left"
                onClick={() => toggle(step_id)}
                data-testid={`wizard-inspect-${step_id}`}
              >
                <span className="font-mono text-xs text-muted-foreground">{step_id}</span>
                <span className="flex-1 text-xs text-muted-foreground">
                  {liveNode?.current || outcome?.message || ''}
                </span>
                {status && <span className="font-mono text-[11px] text-muted-foreground">{status}</span>}
                {outcome?.duration_s ? (
                  <span className="font-mono text-[11px] text-muted-foreground/70">
                    {outcome.duration_s.toFixed(2)}s
                  </span>
                ) : null}
              </button>
              {open === step_id && (
                <div className="pb-1 pl-2 pt-1">
                  <WizardStepInspector
                    outcome={outcome}
                    step={docById.get(step_id)}
                    live={liveNode}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {orphaned.length > 0 && (
        <div className="mt-3 border-t border-border/60 pt-2" data-testid="wizard-orphaned">
          <p className="text-xs text-muted-foreground">
            {/* Never dropped silently: these ran, and hiding them would make an
                edited document look like it had erased its own history. */}
            <Trans>From a previous version of this document</Trans>
          </p>
          <ul className="mt-1">
            {orphaned.map((o) => (
              <li key={o.step_id} className="flex gap-2 text-xs text-muted-foreground">
                <span className="font-mono">{o.step_id}</span>
                <span>{o.status}</span>
                {o.message && <span>— {o.message}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
