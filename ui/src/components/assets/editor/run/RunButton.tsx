import { Button } from '@src/components/ui/button';
import { WORKER_ICON_BUTTON_CLASS } from '@src/components/workers/WorkerToolbar';
import { cn } from '@src/lib/utils';
import { Loader2, Play } from 'lucide-react';
import { forwardRef } from 'react';

interface RunButtonProps {
  onClick?: () => void;
  isRunning?: boolean;
  isStarting?: boolean;
  disabled?: boolean;
  /** Tooltip override; falls back to a state-driven default. */
  title?: string;
  /** Override label text (default: "Run"/"Starting…"/"Running…"). */
  runningLabel?: string;
  startingLabel?: string;
  idleLabel?: string;
  /**
   * Compact, label-less icon button matching the worker-launch toolbar
   * (`WorkerToolbar`) so Run sits inline with the worker icons at the same
   * size. The tooltip carries the state; the visible label is dropped.
   */
  iconOnly?: boolean;
}

/**
 * Shared Run-button used by every editor that exposes a "Run" affordance
 * (workflow, plain markdown, …). The visual contract — Play/Loader2 icon,
 * three labels, disabled state — is identical across editors so users build
 * a single mental model. Editors choose what Run *does* (workflow runs the
 * file directly; plain markdown opens an asset picker).
 *
 * Forwards the ref so it can serve as a Radix Popover trigger via `asChild`.
 */
export const RunButton = forwardRef<HTMLButtonElement, RunButtonProps>(
  function RunButton(
    {
      onClick,
      isRunning = false,
      isStarting = false,
      disabled = false,
      title,
      runningLabel = 'Running…',
      startingLabel = 'Starting…',
      idleLabel = 'Run',
      iconOnly = false,
    },
    ref,
  ) {
    const effectiveTitle =
      title ?? (isRunning ? 'Running…' : isStarting ? 'Starting…' : 'Run');
    const label = isRunning ? runningLabel : isStarting ? startingLabel : idleLabel;
    const showSpinner = isRunning || isStarting;
    const isDisabled = disabled || isRunning || isStarting;
    const iconSize = iconOnly ? 'h-3.5 w-3.5' : 'mr-1 h-4 w-4';
    const icon = showSpinner ? (
      <Loader2 className={cn('animate-spin', iconSize)} />
    ) : (
      <Play className={iconSize} />
    );
    if (iconOnly) {
      return (
        <button
          ref={ref}
          type="button"
          onClick={onClick}
          disabled={isDisabled}
          title={effectiveTitle}
          data-testid="editor-run-button"
          className={WORKER_ICON_BUTTON_CLASS}
        >
          {icon}
        </button>
      );
    }
    return (
      <Button
        ref={ref}
        size="sm"
        onClick={onClick}
        disabled={isDisabled}
        title={effectiveTitle}
        data-testid="editor-run-button"
      >
        {icon}
        {label}
      </Button>
    );
  },
);
