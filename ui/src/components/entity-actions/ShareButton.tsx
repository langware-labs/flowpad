import { Share2 } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { cn } from '@src/lib/utils';
import { Trans, useLingui } from '@lingui/react/macro';

export interface ShareButtonProps {
  onClick: () => void;
  /** Tooltip text shown on hover. */
  tooltip: string;
  /**
   * 'prominent' renders a labeled "Share" pill (header surfaces).
   * 'compact' renders an icon-only button.
   */
  variant?: 'prominent' | 'compact';
  disabled?: boolean;
  testId?: string;
}

/**
 * Canonical "Share to a conversation" button. Single source of truth for the
 * share pill styling, used by EntityActionsToolbar and the markdown editor
 * header so the two never drift apart.
 */
export function ShareButton({
  onClick,
  tooltip,
  variant = 'prominent',
  disabled = false,
  testId,
}: ShareButtonProps) {
  const { t } = useLingui();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          className={cn(
            'transition-colors disabled:cursor-not-allowed disabled:opacity-50',
            variant === 'prominent'
              ? 'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium bg-primary/10 text-primary hover:bg-primary/15'
              : 'inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-accent',
          )}
          data-testid={testId}
          aria-label={t`Share`}
        >
          <Share2 className="h-3.5 w-3.5" />
          {variant === 'prominent' && <Trans>Share</Trans>}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}
