import { Share2 } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { IconWithBadge, type IconComp } from '@src/components/graph-view/icons/IconWithBadge';
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
  /**
   * Optional corner glyph on the Share icon, naming HOW the share travels —
   * e.g. a git branch for a folder, which always ships as a Git origin. Omit
   * when the transport isn't a property of the share (the default copy).
   */
  badge?: IconComp | null;
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
  badge = null,
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
          {/* A badged glyph gets a little more room: the corner icon renders at
              55% of the box, and at the bare 3.5 it degrades to a smudge. */}
          <IconWithBadge Base={Share2} Badge={badge} className={badge ? 'h-4 w-4' : 'h-3.5 w-3.5'} />
          {variant === 'prominent' && <Trans>Share</Trans>}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}
