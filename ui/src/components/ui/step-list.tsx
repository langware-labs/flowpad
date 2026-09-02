import { CheckCircle, Circle, Loader2, XCircle } from 'lucide-react';
import { cn } from '@src/lib/utils';
import type { Step, StepStatus } from '@src/hooks/use-step-flow';

/**
 * Renders the "checked steps" progress list for a {@link useStepFlow} pass.
 *
 * Extracted from the two near-identical copies that lived in `HubHome` (desktop
 * launch) and `LaunchLanding` (`/launch?repo=…`) so a third consumer doesn't
 * fork the pattern again.
 *
 * It also renders a checklist that is not a `useStepFlow` pass at all — one
 * whose steps REFLECT state the user fixes elsewhere (`AgentDeployChecklist`).
 * That is what `Step.action` is for: the row's own remediation control, opt-in
 * and absent from every flow-driven caller.
 */

function StepIcon({ status }: { status: StepStatus }) {
  if (status === 'loading') return <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />;
  if (status === 'success') return <CheckCircle className="h-3.5 w-3.5 text-green-500" />;
  if (status === 'error') return <XCircle className="h-3.5 w-3.5 text-destructive" />;
  return <Circle className="h-3.5 w-3.5 text-muted-foreground/40" />;
}

interface StepListProps {
  steps: Step<string>[];
  /** `data-testid` for the list. Each row also gets `<prefix>-step-<id>`. */
  testId?: string;
  testIdPrefix?: string;
  className?: string;
}

export function StepList({
  steps,
  testId,
  testIdPrefix,
  className = 'flex flex-col gap-1.5 rounded-lg border border-border bg-card/50 px-4 py-3',
}: StepListProps) {
  return (
    <ul className={className} data-testid={testId}>
      {steps.map((step) => (
        <li
          key={step.id}
          // A finished step recedes: the list is read for what is LEFT, and a
          // completed row competing for attention with the one that still needs
          // doing is the thing that makes a checklist hard to scan.
          className={cn('flex items-center gap-2 text-xs', step.status === 'success' && 'opacity-60')}
          data-status={step.status}
          data-testid={testIdPrefix ? `${testIdPrefix}-step-${step.id}` : undefined}
        >
          <StepIcon status={step.status} />
          <span className={step.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}>{step.label}</span>
          {step.detail && <span className="truncate text-muted-foreground/70">— {step.detail}</span>}
          {step.action && <span className="ms-auto shrink-0">{step.action}</span>}
        </li>
      ))}
    </ul>
  );
}
