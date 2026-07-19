import { type WizardData, type WizardProcessResult } from '@sdk';
import { useWizardRun } from '@src/hooks/use-wizard-run';
import { cn } from '@src/lib/utils';
import { Loader2, Wrench } from 'lucide-react';
import { type ReactNode } from 'react';

export interface WizardButtonProps<T = unknown> {
  wizardName: string;
  /** Build the wizard request lazily at click time. */
  buildRequest: () => WizardData | Promise<WizardData>;
  /** Short, simple success popup — e.g. "Your git is ready". */
  successMessage: string | ((data: T | null) => string);
  errorTitle?: string;
  /** Fired with the final result if the button is still mounted. */
  onResult?: (result: WizardProcessResult<T>) => void;
  /** Resting-state content (icon + label). Replaced by the spinner while running. */
  children: ReactNode;
  /** Label shown next to the spinner while running. Default "Working". */
  runningLabel?: ReactNode;
  className?: string;
  title?: string;
  disabled?: boolean;
  testId?: string;
}

/**
 * A button that runs a wizard agent inline instead of popping the modal:
 * single click runs it headless (this button shows a spinner + a live count of
 * the tools the agent has used), and double click opens the full wizard modal.
 * When the run finishes and the button is still on screen, a short popup
 * announces the result. Navigate away and back and the button is idle again —
 * the outcome it produced (report, cloned repo) still exists.
 */
export function WizardButton<T = unknown>({
  wizardName,
  buildRequest,
  successMessage,
  errorTitle,
  onResult,
  children,
  runningLabel = 'Working',
  className,
  title,
  disabled,
  testId,
}: WizardButtonProps<T>) {
  const { phase, toolCount, onClick } = useWizardRun<T>({
    wizardName,
    buildRequest,
    successMessage,
    errorTitle,
    onResult,
  });
  const running = phase === 'running';

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      aria-busy={running}
      title={title ?? 'Click to run · double-click to open the wizard'}
      className={cn(
        'flex items-center gap-1.5 rounded-full border border-transparent px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/60 disabled:opacity-50',
        className,
      )}
    >
      {running ? (
        <>
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>{runningLabel}</span>
          {toolCount > 0 && (
            <span className="inline-flex items-center gap-0.5" title="tools used">
              · {toolCount}
              <Wrench className="h-3 w-3" />
            </span>
          )}
        </>
      ) : (
        children
      )}
    </button>
  );
}
