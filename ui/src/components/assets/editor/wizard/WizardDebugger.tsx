import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Loader2, RotateCcw } from 'lucide-react';
import type { WizardStepOutcome } from '@sdk';

import { Button } from '@src/components/ui/button';

import { WizardStepInspector } from './WizardStepInspector';
import { LIVE_STATE } from './wizard-doc';
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
  live,
  loadingDetail,
  onExpand,
  onReset,
  resetting,
  resetError,
}: {
  steps: WizardRunStep[];
  orphaned: WizardStepOutcome[];
  live: boolean;
  loadingDetail: boolean;
  onExpand: () => void;
  onReset: () => void;
  resetting: boolean;
  resetError: string | null;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState<string | null>(null);

  const toggle = (stepId: string) => {
    const next = open === stepId ? null : stepId;
    setOpen(next);
    // Probes are fetched on the EXPAND gesture, not on advanced mode — the
    // gate is a skin, so keying the fetch off `isAdvanced` would fetch for
    // every wizard anyone opens in Advanced.
    if (next) onExpand();
  };

  return (
    <section className="rounded-md border border-border p-3" data-testid="wizard-debugger">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="flex-1 text-sm font-medium">
          <Trans>Run detail</Trans>
        </h3>
        {loadingDetail && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5"
          // A reset landing mid-run would have the runner write its outcomes
          // into the record just cleared; the backend refuses with a 409 and
          // this keeps the button from inviting it.
          disabled={resetting || live}
          onClick={onReset}
          title={t`Archive this run and start the record fresh`}
          data-testid="wizard-reset"
        >
          {resetting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
          <Trans>Reset</Trans>
        </Button>
      </div>

      <p className="mb-2 text-xs text-muted-foreground">
        {/* Says what reset does NOT do. Approval records that a person trusts
            this wizard to run shell here — a fact about the wizard, not about
            one run's answers — so revoking it would be a different verb. */}
        <Trans>Reset archives this run and clears its answers. It stays approved to run.</Trans>
      </p>

      {resetError && (
        <p className="mb-2 text-xs text-destructive" data-testid="wizard-reset-error">
          {resetError}
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
                  <WizardStepInspector outcome={outcome} />
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
