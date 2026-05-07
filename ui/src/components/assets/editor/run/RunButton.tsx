import { Button } from '@src/components/ui/button';
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
    },
    ref,
  ) {
    const effectiveTitle =
      title ?? (isRunning ? 'Running…' : isStarting ? 'Starting…' : 'Run');
    const label = isRunning ? runningLabel : isStarting ? startingLabel : idleLabel;
    const showSpinner = isRunning || isStarting;
    return (
      <Button
        ref={ref}
        size="sm"
        onClick={onClick}
        disabled={disabled || isRunning || isStarting}
        title={effectiveTitle}
        data-testid="editor-run-button"
      >
        {showSpinner ? (
          <Loader2 className="mr-1 h-4 w-4 animate-spin" />
        ) : (
          <Play className="mr-1 h-4 w-4" />
        )}
        {label}
      </Button>
    );
  },
);
